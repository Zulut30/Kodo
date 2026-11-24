import path from 'node:path';
import { parse } from 'smol-toml';
import { execute } from './command.mjs';
import { rustSourcePaths } from './rust-source-paths.mjs';

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
const pathKey = file => (process.platform === 'win32' ? file.toLowerCase() : file);
const inDirectory = (dir, file) =>
  !dir || pathKey(file) === pathKey(dir) || pathKey(file).startsWith(pathKey(dir) + '/');
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
  const standard = /^(?:src|examples|benches|tests)\/.+\.rs$/.test(local) || pathKey(local) === 'build.rs';
  return standard || targetPaths(members.get(dir)).includes(local) ? dir : null;
}

function extraTargetFiles(members) {
  const files = new Set();
  for (const [dir, doc] of members)
    for (const name of targetPaths(doc)) if (!outside(name) && !name.endsWith('.rs')) files.add(posix.join(dir, name));
  return files;
}

// Resolve paths relative to the source containing the macro. Module attributes
// have a second, lexical base inside inline modules, so uncertain paths widen.
function sourceInputs(file, dir, refs, { dirs, members, changed, links, selected, readers }) {
  for (const { kind, value } of refs) {
    if (!value || value.includes('\\') || posix.isAbsolute(value) || /^[A-Za-z]:/.test(value))
      return 'cargo-source-path';
    if (
      kind === 'path' &&
      (value.split('/').includes('..') || dirs.some(other => other !== dir && inDirectory(dir, other)))
    )
      return 'cargo-source-path';
    let resolved = folder(file);
    for (const component of value.split('/')) {
      resolved = normalized(posix.join(resolved, component));
      if (links.has(pathKey(resolved))) return 'cargo-linked-input';
      if (resolved === '..' || resolved.startsWith('../')) return 'cargo-source-path';
    }
    if (outside(resolved)) return 'cargo-source-path';
    const targetDir = dirs.find(candidate => inDirectory(candidate, resolved));
    if (targetDir !== dir && (targetDir !== undefined || resolved.endsWith('.rs'))) return 'cargo-source-path';
    if (kind === 'path' && !resolved.endsWith('.rs')) return 'cargo-source-path';
    if (changed.has(pathKey(resolved))) {
      if (!members.has(dir)) return 'cargo-source-path';
      selected.add(dir);
      readers.add(pathKey(resolved));
    }
  }
  return null;
}

function cargoLink(link, members, declaredTargets, workspace) {
  if (pathKey(link).endsWith('.rs')) return true;
  if (members.has('') && targetPaths(members.get('')).some(target => inDirectory(folder(target), link))) return true;
  if ([...members.keys()].some(dir => dir && inDirectory(dir, link))) return true;
  if (members.has('') && /^(?:src|tests|benches|examples)(?:\/|$)|^build\.rs$/.test(link)) return true;
  if (
    link === '.cargo' ||
    (shared(link) && (folder(link) === '' || link.startsWith('.cargo/') || matches(folder(link), workspace?.members)))
  )
    return true;
  if (declaredTargets.some(target => target && inDirectory(link, target))) return true;
  if (ancestors(link).some(dir => matches(dir, workspace?.exclude))) return false;
  const patterns = workspace?.members ?? [];
  return patterns.some(pattern => matches(link, ancestors(normalized(pattern))));
}

function hiddenEdge(context, snapshot, buildScripts, root, linkPaths) {
  const { members, dirs } = context;
  const sourceNames = new Set([...snapshot.sources.keys()].map(pathKey));
  const extraTargets = extraTargetFiles(members);
  const declaredTargets = [...members.keys()];
  for (const [dir, doc] of members) {
    for (const name of targetPaths(doc)) {
      const target = posix.join(dir, name);
      if (outside(name) || dirs.find(candidate => inDirectory(candidate, target)) !== dir)
        return 'cargo-external-target';
      declaredTargets.push(target);
    }
    const script = doc.package.build;
    if (typeof script === 'string' || (script !== false && sourceNames.has(pathKey(posix.join(dir, 'build.rs')))))
      buildScripts.add(dir);
  }
  if (linkPaths.some(link => cargoLink(link, members, declaredTargets, root?.workspace))) return 'cargo-linked-input';
  const visited = new Set();
  function inspect(file, dir) {
    const key = JSON.stringify([file, dir]);
    if (visited.has(key)) return null;
    visited.add(key);
    const text = snapshot.sources.get(file);
    if (text === undefined) return 'cargo-source-path';
    const refs = snapshot.references?.get(file) ?? rustSourcePaths(text);
    const reason = sourceInputs(file, dir, refs, context);
    if (reason) return reason;
    for (const { kind, value } of refs)
      if (kind === 'include') {
        const reason = inspect(normalized(posix.join(folder(file), value)), dir);
        if (reason) return reason;
      }
    return null;
  }
  for (const [file, text] of snapshot.sources) {
    if (/(?:^|\/)\.cargo\/config[^/]*$/.test(file)) {
      const config = parse(text);
      if (config.patch || config.source || config.paths || config.include) return 'cargo-config-dependencies';
    }
    if (pathKey(file).endsWith('.rs') || extraTargets.has(file)) {
      const reason = inspect(
        file,
        dirs.find(candidate => inDirectory(candidate, file)),
      );
      if (reason) return reason;
    }
  }
  return null;
}
const documentation = file =>
  /\.md$/i.test(file) || /^(?:LICENSE|CHANGELOG)/.test(posix.basename(file)) || file.startsWith('docs/');

const hasGlob = value => /[*?[]/.test(value);
const uncertainPath = value => typeof value !== 'string' || !value || /[\\{}$\0]|^[A-Za-z]:|^\/\//.test(value);

// Cargo include patterns use gitignore syntax. Prefix each path component in
// both operands so Node's glob matcher also considers leading dots.
function packagePattern(local, pattern) {
  const directoryOnly = pattern.endsWith('/');
  const parts = pathKey(pattern)
    .split('/')
    .filter(part => part && part !== '.');
  const anywhere = parts.length === 1 && !pattern.startsWith('/');
  const glob = parts.map(part => (part === '**' ? part : 'x' + part)).join('/');
  const candidates = ancestors(local);
  if (directoryOnly) candidates.pop();
  return candidates.some(ancestor => {
    const candidate = ancestor
      .split('/')
      .map(part => 'x' + part)
      .join('/');
    return posix.matchesGlob(candidate, glob) || (anywhere && posix.matchesGlob(candidate, '**/' + glob));
  });
}

// Handle each include list in declaration order. An exclusion in this package
// cannot cancel a readme/license reference or a reader in another package.
function manifestInput(field, value, dir, base, { changed, links, dirs }, reads) {
  const include = field === 'include';
  if (uncertainPath(value)) return 'cargo-manifest-path';
  const negative = include && value.startsWith('!');
  const pattern = negative ? value.slice(1) : value;
  if (pattern.startsWith('/') && !include) return 'cargo-manifest-path';
  const parts = pattern.replace(/^\//, '').split('/');
  const glob = hasGlob(pattern);
  if (glob && (!include || parts.includes('..') || /[()]/.test(pattern))) return 'cargo-manifest-path';
  let resolved = base;
  for (const part of parts) {
    resolved = normalized(posix.join(resolved, part));
    if (outside(resolved) && resolved !== '') return 'cargo-manifest-path';
    if (links.has(pathKey(resolved))) return 'cargo-linked-input';
  }
  for (const file of changed) {
    const local = posix.relative(pathKey(base) || '.', file);
    let match = !glob && pathKey(resolved) === file && !pattern.endsWith('/');
    if (include && !outside(local)) {
      // Cargo excludes nested packages and the package's root target directory.
      if (dirs.find(other => inDirectory(other, file)) !== dir || inDirectory('target', local)) continue;
      match ||= packagePattern(local, pattern);
    }
    if (match) {
      if (negative) reads.delete(file);
      else reads.add(file);
    }
  }
  return null;
}

function manifestInputs(context, workspacePackage, reads) {
  for (const [dir, { package: pkg }] of context.members) {
    for (const field of ['readme', 'license-file', 'include']) {
      let value = pkg[field];
      if (value === undefined) continue;
      const inherited = value?.workspace === true;
      if (inherited) value = workspacePackage?.[field];
      if (field === 'readme' && value === false) continue;
      const base = inherited && field !== 'include' ? '' : dir;
      let names = field === 'include' ? value : [value];
      if (field === 'readme' && value === true) names = ['README.md', 'README.txt', 'README'];
      if (!Array.isArray(names)) return 'cargo-manifest-path';
      const fieldReads = new Set();
      for (const name of names) {
        const reason = manifestInput(field, name, dir, base, context, fieldReads);
        if (reason) return reason;
      }
      if (fieldReads.size) context.selected.add(dir);
      for (const file of fieldReads) reads.add(file);
    }
  }
  return null;
}

function packageSpec(doc, root) {
  const version =
    doc.package.version?.workspace === true ? root?.workspace?.package?.version : (doc.package.version ?? '0.0.0');
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
    .filter(dir => dir || root?.package)
    .sort((a, b) => b.length - a.length);
  const selected = new Set();
  const linkPaths = snapshot.entries.filter(entry => entry.mode === '120000').map(entry => entry.file);
  const links = new Set(linkPaths.map(pathKey));
  const unowned = [];
  for (const file of changed) {
    if (shared(file) && !links.has(pathKey(file))) return full('cargo-workspace-input');
    const owner = sourceOwner(file, dirs, members);
    if (owner !== null) selected.add(owner);
    else unowned.push(file);
  }
  const readers = new Set();
  const context = { dirs, members, changed: new Set(changed.map(pathKey)), links, selected, readers };
  const buildScripts = new Set();
  const reason = hiddenEdge(context, snapshot, buildScripts, root, linkPaths);
  if (reason) return full(reason);
  const manifestReads = new Set();
  const manifestReason = manifestInputs(context, root?.workspace?.package, manifestReads);
  if (manifestReason) return full(manifestReason);
  for (const file of unowned) {
    const key = pathKey(file);
    if (manifestReads.has(key)) continue;
    if (dirs.some(dir => inDirectory(dir, file)) && !links.has(key)) return full('cargo-unowned-input');
    if (key.endsWith('.rs') || (!readers.has(key) && !documentation(file))) return full('cargo-unowned-input');
  }
  const reasons = manifestReads.size ? ['cargo-manifest-input'] : [];
  if ([...buildScripts].some(dir => !selected.has(dir))) reasons.push('cargo-build-script-input');
  for (const dir of buildScripts) selected.add(dir);
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
  if (!packages.length) reasons.push('cargo-no-affected-crates');
  return { affectedCrates: packages.map(doc => doc.package.name), packageSpecs, fallback: false, reasons };
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
      pathKey(file).endsWith('.rs') ||
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
  // An include! fragment can itself read files. Read only such source blobs,
  // never arbitrary include_bytes! assets, and keep the submitting crate as owner.
  const references = new Map();
  let pending = [...snapshot.sources.keys()].filter(file => pathKey(file).endsWith('.rs') || extra.has(file));
  while (pending.length) {
    const fragments = new Set();
    for (const file of pending) {
      const refs = rustSourcePaths(snapshot.sources.get(file));
      references.set(file, refs);
      for (const { kind, value } of refs)
        if (kind === 'include' && value && !outside(normalized(posix.join(folder(file), value)))) {
          const target = normalized(posix.join(folder(file), value));
          if (!snapshot.sources.has(target)) fragments.add(target);
        }
    }
    if (!fragments.size) break;
    const more = await readSourceSnapshot(cwd, headSha, file => fragments.has(file));
    pending = [...more.sources.keys()];
    for (const [file, text] of more.sources) snapshot.sources.set(file, text);
  }
  const scope = affectedCrates(docs, changed, { ...snapshot, references });
  const unrelatedLinks = scope.fallback
    ? []
    : snapshot.entries.filter(entry => entry.mode === '120000').map(entry => entry.file);
  return { changed, ...scope, unrelatedLinks };
}
