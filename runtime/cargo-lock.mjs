import { parse } from 'smol-toml';
import { cargoMembers } from './cargo-graph.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { execute } from './command.mjs';
import { ownsPath } from './contracts.mjs';
import { workerEnvironment } from './security.mjs';
import { git } from './workspace.mjs';

// Recognize Cargo's generated subset. Unsupported TOML requires an explicit owner.
function packages(text) {
  let doc;
  try {
    doc = parse(text);
  } catch {
    return null;
  }
  if (
    ![3, 4].includes(doc.version) ||
    !Array.isArray(doc.package) ||
    !doc.package.length ||
    Object.keys(doc).some(key => !['version', 'package'].includes(key))
  )
    return null;
  const result = new Map();
  for (const pkg of doc.package) {
    if (
      !pkg ||
      typeof pkg !== 'object' ||
      Object.keys(pkg).some(key => !['name', 'source', 'version', 'checksum', 'dependencies'].includes(key))
    )
      return null;
    const { name, version, source, checksum, dependencies } = pkg;
    if (
      typeof name !== 'string' ||
      !name ||
      typeof version !== 'string' ||
      !version ||
      (source !== undefined && typeof source !== 'string') ||
      (checksum !== undefined && typeof checksum !== 'string') ||
      (dependencies !== undefined &&
        (!Array.isArray(dependencies) || dependencies.some(value => typeof value !== 'string')))
    )
      return null;
    const versions = result.get(name) ?? new Map();
    const identity = JSON.stringify([source, version]);
    if (versions.has(identity)) return null;
    versions.set(identity, checksum);
    result.set(name, versions);
  }
  return result;
}

export function lockChange(before, after) {
  const left = packages(before),
    right = packages(after);
  if (!left || !right) return 'scope';
  for (const [name, versions] of left) {
    const next = right.get(name);
    if (!next) continue;
    for (const [key, checksum] of versions)
      if (next.has(key) && next.get(key) !== checksum) return 'cargo_lock_version_change';
    if ([...versions.keys()].some(key => !next.has(key)) && [...next.keys()].some(key => !versions.has(key)))
      return 'cargo_lock_version_change';
  }
  return null;
}

export const isLock = file => path.posix.basename(file) === 'Cargo.lock';
const raw = { rawOutput: true };
async function fileAt(cwd, rev, file) {
  if (rev) return git(cwd, ['show', rev + ':' + file], raw);
  const target = path.resolve(cwd, file),
    stat = await lstat(target);
  if (
    !stat.isFile() ||
    stat.size > 16 * 1024 * 1024 ||
    (await realpath(target)) !== path.resolve(await realpath(cwd), file)
  )
    throw Error('unreadable Cargo file');
  return readFile(target, 'utf8');
}

async function memberChanged(cwd, rev, file, changed) {
  const root = path.posix.dirname(file);
  const rootManifest = path.posix.join(root, 'Cargo.toml');
  const args = rev
    ? ['ls-tree', '-r', '--name-only', '-z', rev]
    : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const names = (await execute('git', args, { cwd, ...raw })).stdout
    .split('\0')
    .filter(name => path.posix.basename(name) === 'Cargo.toml');
  const docs = new Map();
  for (const name of names) {
    try {
      docs.set(name, parse(await fileAt(cwd, rev, name)));
    } catch {
      return false;
    }
  }
  if (!docs.has(rootManifest)) return false;
  // An ordinary member crate cannot grant implicit ownership of a second lock inside its directory.
  if (root !== '.' && !docs.get(rootManifest).workspace) {
    let parent = path.posix.dirname(root);
    while (true) {
      if (cargoMembers(docs, parent).has(root)) return false;
      if (parent === '.') break;
      parent = path.posix.dirname(parent);
    }
  }
  const members = cargoMembers(docs, root);
  return changed.some(
    name =>
      (name === rootManifest && (docs.get(name).workspace || docs.get(name).package)) ||
      members.has(path.posix.dirname(name).replace(/^\.$/, '')),
  );
}

export async function implicitLock(cwd, before, after, file, changed, scopes) {
  try {
    const manifests = changed.filter(name => path.posix.basename(name) === 'Cargo.toml' && ownsPath(scopes, name));
    if (
      manifests.length &&
      ((await memberChanged(cwd, after, file, manifests)) || (await memberChanged(cwd, before, file, manifests)))
    )
      return lockChange(await fileAt(cwd, before, file), await fileAt(cwd, after, file));
  } catch {
    /* Missing or unreadable objects require an explicit owner. */
  }
  return 'scope';
}

export async function regenerate(cwd, tree, before, head, files, signal) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'kodo-cargo-'));
  try {
    const index = path.join(temp, 'index-repo'),
      work = path.join(temp, 'workspace');
    await mkdir(work);
    await git(temp, ['init', '--bare', index]);
    const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], raw);
    // Git keeps this private index under index-repo and writes tree objects in the original object store.
    // No ref in the common directory is checked out or advanced.
    await writeFile(path.join(index, 'commondir'), common + '\n');
    const run = args => git(temp, ['--git-dir', index, '--work-tree', work, ...args], raw);
    await run(['read-tree', tree]);
    for (const file of files) {
      const entry = await git(cwd, ['ls-tree', before, '--', file], raw);
      const blob = /^100644 blob ([0-9a-f]+)\t/.exec(entry)?.[1];
      if (!blob) throw Error();
      await run(['update-index', '--cacheinfo', '100644', blob, file]);
    }
    await run(['checkout-index', '--all']);
    for (const file of files) {
      const dir = path.dirname(path.join(work, file));
      const options = { cwd: dir, env: workerEnvironment(), timeoutMs: 120000, signal };
      for (const flags of [[], ['--locked', '--no-deps']])
        await execute('cargo', ['metadata', '--offline', '--format-version', '1', ...flags], options);
      const contents = await readFile(path.join(work, file), 'utf8');
      for (const parent of [before, head]) if (lockChange(await fileAt(cwd, parent, file), contents)) throw Error();
      const blob = await git(cwd, ['hash-object', '-w', '--stdin'], { input: contents });
      await run(['update-index', '--cacheinfo', '100644', blob, file]);
    }
    return await run(['write-tree']);
  } catch (error) {
    if (error.code === 'cancelled') throw error;
    throw Object.assign(Error('Project integration_conflict: cargo_lock_unresolved'), {
      code: 'project_integration_conflict',
      reason: 'cargo_lock_unresolved',
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
