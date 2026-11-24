import path from 'node:path';
import { parse } from 'smol-toml';
import { execute } from './command.mjs';

const posix = path.posix;
const folder = name => (posix.dirname(name) === '.' ? '' : posix.dirname(name));
const manifestAt = dir => posix.join(dir, 'Cargo.toml');
const matches = (dir, patterns = []) =>
  patterns.some(pattern => posix.matchesGlob(dir, posix.normalize(pattern).replace(/\/$/, '')));

function dependencies(doc, rootDoc, dir, root) {
  const paths = [];
  for (const table of [doc, ...Object.values(doc.target ?? {})]) {
    for (const key of [
      'dependencies',
      'dev-dependencies',
      'build-dependencies',
      'dev_dependencies',
      'build_dependencies',
    ]) {
      for (const [alias, spec] of Object.entries(table[key] ?? {})) {
        const inherited = spec?.workspace === true;
        const dep = inherited ? rootDoc.workspace?.dependencies?.[alias] : spec;
        if (inherited && !dep) throw new Error('unknown workspace dependency');
        if (dep?.path)
          paths.push(
            posix
              .normalize(posix.join(inherited ? root : dir, dep.path))
              .replace(/\/$/, '')
              .replace(/^\.$/, ''),
          );
      }
    }
  }
  return paths;
}

// Include implicit workspace members reached through local path dependencies.
export function cargoMembers(documents, root = '') {
  const rootDoc = documents.get(manifestAt(root)),
    workspace = rootDoc?.workspace ?? {};
  const members = new Map();
  const add = dir => {
    const doc = documents.get(manifestAt(dir));
    if (doc?.package && !members.has(dir)) members.set(dir, doc);
  };
  add(root);
  const relativeDir = dir => posix.relative(root || '.', dir || '.');
  const eligible = dir => {
    const rel = relativeDir(dir);
    return rel !== '..' && !rel.startsWith('../') && !matches(rel, workspace.exclude);
  };
  if (rootDoc?.workspace) {
    for (const [name, doc] of documents) {
      if (posix.basename(name) !== 'Cargo.toml' || !doc?.package) continue;
      const dir = folder(name);
      if (eligible(dir) && matches(relativeDir(dir), workspace.members)) add(dir);
    }
    for (const [dir, doc] of members)
      for (const dep of dependencies(doc, rootDoc, dir, root)) if (eligible(dep)) add(dep);
  }
  return members;
}

export function affectedCrates(documents, changed) {
  const members = cargoMembers(documents),
    root = documents.get('Cargo.toml');
  const all = [...members.values()].map(doc => doc.package.name);
  const full = reason => ({ affectedCrates: all, fallback: true, reasons: [reason] });
  if (
    !changed.length ||
    root?.patch ||
    root?.replace ||
    !all.length ||
    all.some(n => typeof n !== 'string' || !/^[-\w]+$/.test(n))
  )
    return full('cargo-graph-unknown');
  const dirs = [...members.keys()].sort((a, b) => b.length - a.length);
  const selected = new Set(),
    consumers = new Map();
  for (const file of changed) {
    if (/^(?:Cargo\.(?:toml|lock)|rust-toolchain(?:\.toml)?|\.cargo\/config[^/]*)$/.test(file))
      return full('cargo-workspace-input');
    const dir = dirs.find(d => !d || file.startsWith(d + '/'));
    if (dir === undefined || file.endsWith('/Cargo.toml')) return full('cargo-ownership-or-graph-change');
    selected.add(dir);
  }
  for (const [dir, doc] of members)
    for (const dep of dependencies(doc, root, dir, '')) {
      if (!members.has(dep)) return full('cargo-external-path-dependency');
      if (!consumers.has(dep)) consumers.set(dep, []);
      consumers.get(dep).push(dir);
    }
  for (const dir of selected) for (const consumer of consumers.get(dir) ?? []) selected.add(consumer);
  return { affectedCrates: [...selected].map(d => members.get(d).package.name), fallback: false, reasons: [] };
}

// Read manifest blobs at the submitted commit. A rename contributes both paths.
export async function cargoPlanAt(cwd, baseSha, headSha) {
  if (![baseSha, headSha].every(sha => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)))
    throw new Error('Invalid cargo graph revisions');
  const read = async args => (await execute('git', args, { cwd, rawOutput: true, timeoutMs: 30000 })).stdout;
  const changed = (await read(['diff', '--no-renames', '--name-only', '-z', baseSha, headSha, '--']))
    .split('\0')
    .filter(Boolean);
  const { readSourceSnapshot } = await import('./ci-graph.mjs');
  const { sources } = await readSourceSnapshot(cwd, headSha, file => posix.basename(file) === 'Cargo.toml');
  const docs = new Map([...sources].map(([name, text]) => [name, parse(text)]));
  return { changed, ...affectedCrates(docs, changed) };
}
