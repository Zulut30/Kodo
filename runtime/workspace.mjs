import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execute } from './command.mjs';
import { secretFile, redact } from './security.mjs';
export async function git(cwd, args, options = {}) { return (await execute('git', args, { cwd, ...options })).stdout.trim(); }
export async function diffHash(cwd, baseSha, headSha = 'HEAD') { return createHash('sha256').update((await execute('git', ['diff', '--binary', `${baseSha}...${headSha}`], { cwd })).stdout.trimEnd()).digest('hex'); }
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
  if (exists) { if (await git(directory, ['branch', '--show-current']) !== branch) throw new Error('Несоответствие ветки существующего worktree'); return directory; }
  const branchExists = (await execute('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: project, allowFailure: true })).code === 0;
  await git(project, branchExists ? ['worktree', 'add', directory, branch] : ['worktree', 'add', '-b', branch, directory, base]); return directory;
}
export async function collectFiles(cwd, task, secrets = {}) {
  const names = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const terms = task.toLowerCase().split(/\W+/).filter(word => word.length > 3);
  const eligible = names.filter(name => !secretFile(name) && !/(^|\/)(node_modules|dist|build|coverage|\.git|vendor)\//.test(name) && !/^skills\/[^/]+\/references\/upstream\//.test(name) && !/(lock\.json|lock\.yaml|\.lock)$/.test(name));
  eligible.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  function score(name) { return (/(package\.json|README|AGENTS|kodo.config)/.test(name) ? 20 : 0) + terms.filter(term => name.toLowerCase().includes(term)).length * 5; }
  const files = []; let size = 0;
  for (const name of eligible) {
    if (files.length >= 150 || size >= 450000) break;
    const filename = path.join(cwd, name), stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50000) continue;
    const data = await readFile(filename); if (data.includes(0)) continue;
    files.push({ path: name, content: redact(data.toString('utf8'), secrets) }); size += data.length;
  }
  return { files, omitted: names.length - files.length, bytes: size };
}
export async function changedFiles(cwd, base) { return (await git(cwd, ['diff', '--no-renames', '--name-only', base])).split('\n').filter(Boolean); }
export async function commitChanges(cwd, message) {
  await git(cwd, ['add', '-A']);
  const result = await execute('git', ['diff', '--cached', '--quiet'], { cwd, allowFailure: true });
  if (result.code === 1) await git(cwd, ['commit', '-m', message]);
  else if (result.code !== 0) throw new Error('Не удалось проверить staged changes');
  return git(cwd, ['rev-parse', 'HEAD']);
}
