import path from 'node:path';
import { parse } from 'smol-toml';
import { execute } from './command.mjs';

const posix = path.posix;
const folder = name => (posix.dirname(name) === '.' ? '' : posix.dirname(name));
const manifestAt = dir => posix.join(dir, 'Cargo.toml');
const normalized = dir =>
  posix
    .normalize(dir || '.')
    .replace(/\/$/, '')
    .replace(/^\.$/, '');
const matches = (dir, patterns = []) =>
  patterns.some(pattern => dir === normalized(pattern) || posix.matchesGlob(dir, normalized(pattern)));
const inDirectory = (dir, file) => !dir || file === dir || file.startsWith(dir + '/');
function ancestors(dir) {
  const parts = dir.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

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
        if (dep?.path) paths.push(normalized(posix.join(inherited ? root : dir, dep.path)));
      }
    }
  }
  return paths;
}

// Include implicit workspace members reached through local path dependencies.
export function cargoMembers(documents, root = '') {
  root = normalized(root);
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
    if (rel === '..' || rel.startsWith('../')) return false;
    return !ancestors(rel).some(
      parent =>
        matches(parent, workspace.exclude) ||
        (parent && documents.get(manifestAt(posix.join(root, parent)))?.workspace),
    );
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

function targetPaths(doc) {
  const explicit = [doc.lib, ...['bin', 'test', 'bench', 'example'].flatMap(key => doc[key] ?? [])].flatMap(target =>
    target?.path === undefined ? [] : [target.path],
  );
  if (typeof doc.package.build === 'string') explicit.push(doc.package.build);
  return explicit.map(name => normalized(name.replaceAll('\\', '/')));
}
const outside = name =>
  !name || name === '..' || name.startsWith('../') || posix.isAbsolute(name) || /^[A-Za-z]:/.test(name);
const shared = file => /(?:^|\/)(?:Cargo\.(?:toml|lock)|rust-toolchain[^/]*|\.cargo\/config[^/]*)$/.test(file);
function sourceOwner(file, dirs, members) {
  const dir = dirs.find(candidate => inDirectory(candidate, file));
  if (!members.has(dir) || shared(file)) return null;
  const local = dir ? file.slice(dir.length + 1) : file;
  const standard = /^(?:src|examples|benches|tests)\/.+\.rs$/.test(local) || local === 'build.rs';
  return standard || targetPaths(members.get(dir)).includes(local) ? dir : null;
}

// A dynamic expression, escape sequence, or unfamiliar spelling cannot prove confinement.
function hiddenSourcePath(text, file, dir, dirs) {
  for (const match of text.matchAll(/\b(include(?:_bytes|_str)?|path)\b/g)) {
    const rest = text.slice(match.index + match[0].length);
    const attribute = match[0] === 'path';
    if (!/^\s*(?:!|=|\/[*/])/.test(rest)) continue;
    const prefix = attribute ? /^\s*=\s*/ : /^\s*!\s*[(\[{]\s*/;
    const start = prefix.exec(rest);
    if (!start) return true;
    const value = /^(?:"([^"\\]*)"|r(#*)"([^"]*)"\2)/.exec(rest.slice(start[0].length));
    if (!value) return true;
    const relative = value[1] ?? value[3];
    if (relative.includes('\\') || posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return true;
    // Attribute paths may be relative to an enclosing inline module or a #[path] module.
    if (attribute && relative.split('/').includes('..')) return true;
    if ((attribute || match[0] === 'include') && !relative.endsWith('.rs')) return true;
    const resolved = normalized(posix.join(folder(file), relative));
    if (outside(resolved) || dirs.find(candidate => inDirectory(candidate, resolved)) !== dir) return true;
  }
  return false;
}

function extraTargetFiles(members) {
  const files = new Set();
  for (const [dir, doc] of members)
    for (const name of targetPaths(doc)) if (!outside(name) && !name.endsWith('.rs')) files.add(posix.join(dir, name));
  return files;
}

function hiddenEdge(members, owners, snapshot, dirs) {
  const extraTargets = extraTargetFiles(members);
  for (const [dir, doc] of members) {
    if (
      targetPaths(doc).some(
        name => outside(name) || dirs.find(candidate => inDirectory(candidate, posix.join(dir, name))) !== dir,
      )
    )
      return 'cargo-external-target';
    const script = doc.package.build;
    if (
      (typeof script === 'string' || (script !== false && snapshot.sources.has(posix.join(dir, 'build.rs')))) &&
      [...owners].some(owner => owner !== dir)
    )
      return 'cargo-build-script-input';
  }
  for (const { mode } of snapshot.entries) if (mode === '120000') return 'cargo-linked-input';
  for (const [file, text] of snapshot.sources) {
    if (/(?:^|\/)\.cargo\/config[^/]*$/.test(file)) {
      const config = parse(text);
      if (config.patch || config.source || config.paths || config.include) return 'cargo-config-dependencies';
    }
    if (file.endsWith('.rs') || extraTargets.has(file)) {
      const dir = dirs.find(candidate => inDirectory(candidate, file));
      if (dir === undefined || hiddenSourcePath(text, file, dir, dirs)) return 'cargo-source-path';
    }
  }
  return null;
}

function packageSpec(doc, root) {
  const version = doc.package.version?.workspace === true ? root?.workspace?.package?.version : doc.package.version;
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)
    ? doc.package.name + '@' + version
    : null;
}

export function affectedCrates(documents, changed, snapshot = { entries: [], sources: new Map() }) {
  const members = cargoMembers(documents),
    root = documents.get('Cargo.toml');
  const all = [...members.values()].map(doc => doc.package.name);
  const full = reason => ({ affectedCrates: all, fallback: true, reasons: [reason], packageSpecs: [] });
  if (
    !changed.length ||
    root?.patch ||
    root?.replace ||
    !all.length ||
    all.some(name => typeof name !== 'string' || !/^[-\w]+$/.test(name))
  )
    return full('cargo-graph-unknown');
  const dirs = [...documents.keys()]
    .filter(file => posix.basename(file) === 'Cargo.toml')
    .map(folder)
    .sort((a, b) => b.length - a.length);
  const selected = new Set();
  for (const file of changed) {
    if (shared(file)) return full('cargo-workspace-input');
    const owner = sourceOwner(file, dirs, members);
    if (owner === null) return full('cargo-unowned-input');
    selected.add(owner);
  }
  const reason = hiddenEdge(members, selected, snapshot, dirs);
  if (reason) return full(reason);
  const consumers = new Map();
  for (const [dir, doc] of members)
    for (const dep of dependencies(doc, root, dir, '')) {
      if (!members.has(dep)) return full('cargo-external-path-dependency');
      if (!consumers.has(dep)) consumers.set(dep, []);
      consumers.get(dep).push(dir);
    }
  for (const dir of selected) for (const consumer of consumers.get(dir) ?? []) selected.add(consumer);
  const packages = [...selected].map(dir => members.get(dir));
  const packageSpecs = packages.map(doc => packageSpec(doc, root));
  const lock = snapshot.sources.get('Cargo.lock');
  const external = lock ? (parse(lock).package ?? []) : [];
  if (
    packageSpecs.some(spec => !spec) ||
    !Array.isArray(external) ||
    external.some(
      pkg =>
        typeof pkg !== 'object' ||
        !('name' in pkg) ||
        !('version' in pkg) ||
        ('source' in pkg && packageSpecs.includes(pkg.name + '@' + pkg.version)),
    )
  )
    return full('cargo-ambiguous-package');
  return { affectedCrates: packages.map(doc => doc.package.name), packageSpecs, fallback: false, reasons: [] };
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
  const snapshot = await readSourceSnapshot(
    cwd,
    headSha,
    file =>
      posix.basename(file) === 'Cargo.toml' ||
      file.endsWith('.rs') ||
      file === 'Cargo.lock' ||
      /(?:^|\/)\.cargo\/config[^/]*$/.test(file),
  );
  const docs = new Map();
  for (const [file, text] of snapshot.sources) if (posix.basename(file) === 'Cargo.toml') docs.set(file, parse(text));
  const extra = extraTargetFiles(cargoMembers(docs));
  if (extra.size) {
    const targets = await readSourceSnapshot(cwd, headSha, file => extra.has(file));
    for (const [file, text] of targets.sources) snapshot.sources.set(file, text);
  }
  return { changed, ...affectedCrates(docs, changed, snapshot) };
}
