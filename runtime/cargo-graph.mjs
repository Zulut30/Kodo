import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { cargoPathAliasProbe } from './cargo-directory-case.mjs';
import { resolveCargoWorkspace } from './cargo-workspace.mjs';
import { execute } from './command.mjs';
import { rustSourcePaths } from './rust-source-paths.mjs';
import { workerEnvironment } from './security.mjs';
import { noLinks } from './toolchains.mjs';

const posix = path.posix;
const folder = name => (posix.dirname(name) === '.' ? '' : posix.dirname(name));
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

/**
 * Resolve a Cargo workspace through the canonical resolver in cargo-workspace.mjs.
 * @param {Map<string, any>} documents
 * @param {string} [root]
 * @param {{ files?: Array<string | { path: string }>, probeAlias?: (original: string, spelling: string) => boolean }} [options]
 */
export function cargoWorkspace(documents, root = '', options = {}) {
  const manifests = new Map();
  for (const [name, doc] of documents) {
    if (posix.basename(name) === 'Cargo.toml') manifests.set(name, doc);
  }
  return resolveCargoWorkspace({
    ...options,
    manifests,
    startDir: normalized(root),
  });
}

/**
 * Include implicit workspace members reached through local path dependencies.
 * @param {Map<string, any>} documents
 * @param {string} [root]
 * @param {{ files?: Array<string | { path: string }>, probeAlias?: (original: string, spelling: string) => boolean }} [options]
 */
export function cargoMembers(documents, root = '', options = {}) {
  const resolved = cargoWorkspace(documents, root, options);
  return new Map(resolved.members.map(member => [member.root, member.doc]));
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

// A changed file no package source owns widens the plan unless it is documentation with a known
// reader. package.include and readme name archive inputs, not the only readers: only
// documentation claimed by a manifest stays narrow; assets, data and Rust files still widen.
function widensUnowned(file, { dirs, links, readers }, manifestReads) {
  const key = pathKey(file);
  if (manifestReads.has(key) && documentation(file) && !key.endsWith('.rs')) return false;
  if (dirs.some(dir => inDirectory(dir, file)) && !links.has(key)) return true;
  return key.endsWith('.rs') || (!readers.has(key) && !documentation(file));
}

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

export function affectedCrates(
  documents,
  changed,
  snapshot = { entries: [], sources: new Map() },
  probeAlias = undefined,
) {
  const entries = snapshot.entries ?? [];
  const linkPaths = entries.filter(entry => entry.mode === '120000').map(entry => entry.file);
  const nonLinkEntries = entries.filter(entry => entry.mode !== '120000').map(entry => entry.file);
  const files = [...nonLinkEntries, ...(snapshot.sources ? snapshot.sources.keys() : [])];
  const workspace = cargoWorkspace(documents, '', { files: files.length ? files : undefined, probeAlias });
  const members = new Map(workspace.members.map(member => [member.root, member.doc]));
  const root = documents.get('Cargo.toml');
  const all = [...members.values()].map(doc => doc.package.name);
  const full = reason => ({ affectedCrates: all, fallback: true, reasons: [reason], packageSpecs: [] });
  if (workspace.unsupported.length) {
    if (linkPaths.some(link => cargoLink(link, members, [...members.keys()], root?.workspace)))
      return full('cargo-linked-input');
    return full('cargo-workspace-unsupported');
  }
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
  if (unowned.some(file => widensUnowned(file, context, manifestReads))) return full('cargo-unowned-input');
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

const isCargoSourceFile = file =>
  posix.basename(file) === 'Cargo.toml' ||
  pathKey(file).endsWith('.rs') ||
  file === 'Cargo.lock' ||
  /(?:^|\/)\.cargo\/config[^/]*$/.test(file);

const feedbackConfigFile = file => /^(?:\.gitignore|architecture\.policy\.json|kodo\.config\.json)$/.test(file);
const sortedUnique = values => [...new Set(values)].sort();
const digestJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function overlayWorkingChanges(project, snapshot, changedPaths) {
  if (!changedPaths.length) return snapshot;
  const entriesByFile = new Map(snapshot.entries.map(entry => [entry.file, entry]));
  const sources = new Map(snapshot.sources);
  for (const file of changedPaths) {
    const absolute = path.join(project, ...file.split('/'));
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        entriesByFile.delete(file);
        sources.delete(file);
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      entriesByFile.set(file, { mode: '120000', type: 'blob', oid: '0'.repeat(40), file });
      sources.delete(file);
      continue;
    }
    if (!info.isFile() || info.size > 16 * 1024 * 1024) continue;
    const bytes = await readFile(absolute);
    entriesByFile.set(file, {
      mode: '100644',
      type: 'blob',
      oid: createHash('sha256').update(bytes).digest('hex'),
      file,
    });
    if (isCargoSourceFile(file)) sources.set(file, bytes.toString('utf8'));
  }
  const entries = [...entriesByFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { entries, sources };
}

async function readFeedbackBlobs(project, headSha, changedSet, files, readSourceSnapshot) {
  const results = new Map();
  const committed = new Set();
  for (const file of files) {
    if (changedSet.has(file)) {
      try {
        const absolute = path.join(project, ...file.split('/'));
        const info = await lstat(absolute);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024)
          results.set(file, await readFile(absolute, 'utf8'));
      } catch {
        // Missing or unreadable working-tree file leaves entry absent.
      }
    } else {
      committed.add(file);
    }
  }
  if (committed.size) {
    const extra = await readSourceSnapshot(project, headSha, name => committed.has(name));
    for (const [file, text] of extra.sources) results.set(file, text);
  }
  return results;
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
  const snapshot = await readSourceSnapshot(cwd, headSha, isCargoSourceFile);
  const docs = new Map();
  for (const [file, text] of snapshot.sources) if (posix.basename(file) === 'Cargo.toml') docs.set(file, parse(text));
  const nonLinkFiles = snapshot.entries.filter(entry => entry.mode !== '120000').map(entry => entry.file);
  const probeAlias = cargoPathAliasProbe(cwd);
  const extra = extraTargetFiles(cargoMembers(docs, '', { files: nonLinkFiles, probeAlias }));
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
  const scope = affectedCrates(docs, changed, { ...snapshot, references }, probeAlias);
  const unrelatedLinks = scope.fallback
    ? []
    : snapshot.entries.filter(entry => entry.mode === '120000').map(entry => entry.file);
  return { changed, ...scope, unrelatedLinks };
}

async function collectFeedbackReferences(project, headSha, changedSet, snapshot, members, readSourceSnapshot) {
  const extra = extraTargetFiles(members);
  const missingExtra = [...extra].filter(file => !snapshot.sources.has(file));
  if (missingExtra.length) {
    const loaded = await readFeedbackBlobs(project, headSha, changedSet, missingExtra, readSourceSnapshot);
    for (const [file, text] of loaded) snapshot.sources.set(file, text);
  }
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
    const loaded = await readFeedbackBlobs(project, headSha, changedSet, fragments, readSourceSnapshot);
    const nextPending = [];
    for (const [file, text] of loaded) {
      snapshot.sources.set(file, text);
      nextPending.push(file);
    }
    pending = nextPending;
  }
  return references;
}

/** Build a CI-graph-compatible Cargo affected plan for worker `kodo ci feedback` self-checks. */
export async function cargoFeedbackGraph({ project, baseSha, headSha, changedPaths = [] }, dependencies = {}) {
  project = path.resolve(project);
  await noLinks(project);
  project = await realpath(project);
  const gitRead = async args =>
    (await execute('git', args, { cwd: project, env: workerEnvironment(), rawOutput: true, timeoutMs: 30000 })).stdout;
  if ((await realpath(path.resolve((await gitRead(['rev-parse', '--show-toplevel'])).trim()))) !== project)
    throw new Error('Affected project must be the repository root');
  if (![baseSha, headSha].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha)))
    throw new Error('Invalid cargo graph revisions');
  const diffChanged = (await gitRead(['diff', '--no-renames', '--name-only', '-z', baseSha, headSha, '--']))
    .split('\0')
    .filter(Boolean);
  const changedFiles = sortedUnique([...diffChanged, ...changedPaths]);
  const changedSet = new Set(changedPaths);
  const readSourceSnapshot = dependencies.readSourceSnapshot ?? (await import('./ci-graph.mjs')).readSourceSnapshot;
  const snapshot = await overlayWorkingChanges(
    project,
    await readSourceSnapshot(project, headSha, isCargoSourceFile),
    changedPaths,
  );
  const allFiles = sortedUnique([...snapshot.entries.map(entry => entry.file), ...changedFiles]);
  const hashes = {
    sourceHash: digestJson(snapshot.entries.map(({ file, mode, oid }) => [file, mode, oid])),
    dependencyHash: digestJson(
      snapshot.entries
        .filter(entry => posix.basename(entry.file) === 'Cargo.toml' || posix.basename(entry.file) === 'Cargo.lock')
        .map(({ file, oid }) => [file, oid]),
    ),
  };
  const result = (affectedFiles, affectedCratesList, fallback, reasons) => ({
    schemaVersion: 1,
    changedFiles,
    affectedFiles,
    affectedCrates: affectedCratesList,
    testFiles: [],
    fallback,
    reasons: sortedUnique(reasons),
    ...hashes,
  });

  const docs = new Map();
  try {
    for (const [file, text] of snapshot.sources) if (posix.basename(file) === 'Cargo.toml') docs.set(file, parse(text));
  } catch {
    return result(allFiles, [], true, ['cargo-workspace-unsupported']);
  }

  const nonLinkFiles = snapshot.entries.filter(entry => entry.mode !== '120000').map(entry => entry.file);
  const probeAlias = cargoPathAliasProbe(project);
  const workspace = cargoWorkspace(docs, '', { files: nonLinkFiles, probeAlias });
  const members = new Map(workspace.members.map(member => [member.root, member.doc]));
  const references = await collectFeedbackReferences(
    project,
    headSha,
    changedSet,
    snapshot,
    members,
    readSourceSnapshot,
  );

  if (workspace.unsupported.length) {
    const linkPaths = snapshot.entries.filter(entry => entry.mode === '120000').map(entry => entry.file);
    const reason = linkPaths.some(link =>
      cargoLink(link, members, [...members.keys()], docs.get('Cargo.toml')?.workspace),
    )
      ? 'cargo-linked-input'
      : 'cargo-workspace-unsupported';
    return result(allFiles, workspace.members.map(member => member.name).sort(), true, [reason]);
  }

  const cargoChanged = changedFiles.filter(file => !feedbackConfigFile(file));
  if (!cargoChanged.length) return result(changedFiles, [], false, []);

  const scope = affectedCrates(docs, cargoChanged, { ...snapshot, references }, probeAlias);
  let { fallback, reasons } = scope;
  let affectedCrateNames = sortedUnique(scope.affectedCrates);
  if (fallback && reasons.length && reasons.every(reason => reason === 'cargo-workspace-input')) {
    fallback = false;
    reasons = [];
    affectedCrateNames = workspace.members.map(member => member.name).sort();
  }
  if (fallback) return result(allFiles, affectedCrateNames, true, reasons);

  const affectedNameSet = new Set(affectedCrateNames);
  const affectedDirs = new Set(
    workspace.members.filter(member => affectedNameSet.has(member.name)).map(member => member.root),
  );
  const sortedMemberDirs = [...members.keys()].sort((a, b) => b.length - a.length);
  const ownedRustFiles = snapshot.entries
    .filter(entry => entry.mode !== '120000' && pathKey(entry.file).endsWith('.rs'))
    .map(entry => entry.file)
    .filter(file => {
      const owner = sortedMemberDirs.find(dir => inDirectory(dir, file));
      return owner !== undefined && affectedDirs.has(owner);
    });
  return result(sortedUnique([...changedFiles, ...ownedRustFiles]), affectedCrateNames, false, reasons);
}
