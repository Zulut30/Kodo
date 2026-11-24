/** Offline Cargo workspace parser and Rust crate graph builder for Architecture Guardian. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isPlain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function canonical(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlain(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  throw Object.assign(new Error('Architecture Rust graph: configuration'), { code: 'configuration' });
}
const hash = value => digest(JSON.stringify(canonical(value)));

function decodeUtf8(raw) {
  if (typeof raw === 'string') return { text: raw, bytes: Buffer.from(raw, 'utf8') };
  if (!Buffer.isBuffer(raw)) return null;
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) return null;
  return { text, bytes: raw };
}

function normalizeMemberPattern(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 1024 ||
    /[\\:\x00-\x1f\x7f[\]{}]/.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.includes('**')
  )
    return null;
  const cleaned = trimmed.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!cleaned || cleaned === '.') return '';
  const parts = cleaned.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return cleaned;
}

function segmentMatches(pattern, segment) {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === segment;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '[^/]+')
    .replaceAll('?', '[^/]');
  return new RegExp(`^${escaped}$`).test(segment);
}

function matchesMemberPattern(pattern, dir) {
  if (pattern === '') return dir === '';
  if (!dir) return false;
  const patternParts = pattern.split('/');
  const dirParts = dir.split('/');
  if (patternParts.length !== dirParts.length) return false;
  return patternParts.every((part, index) => segmentMatches(part, dirParts[index]));
}

function resolveRelativeDir(fromDir, rawPath) {
  if (
    typeof rawPath !== 'string' ||
    !rawPath.trim() ||
    rawPath.length > 1024 ||
    /[\\:\x00-\x1f\x7f*?[\]{}]/.test(rawPath) ||
    rawPath.startsWith('/')
  )
    return null;
  const stack = fromDir ? fromDir.split('/') : [];
  for (const part of rawPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(part);
  }
  return stack.join('/');
}

function parseWorkspaceDependencies(rawDeps) {
  const map = new Map();
  if (!isPlain(rawDeps)) return map;
  for (const key of Object.keys(rawDeps).sort(compare)) {
    const spec = rawDeps[key];
    if (typeof spec === 'string') {
      map.set(key, { key, packageName: key, path: null, valid: true });
    } else if (isPlain(spec)) {
      const packageName = typeof spec.package === 'string' && spec.package.trim() ? spec.package.trim() : key;
      const depPath = spec.path === undefined ? null : typeof spec.path === 'string' ? spec.path : undefined;
      map.set(key, { key, packageName, path: depPath ?? null, valid: depPath !== undefined });
    } else {
      map.set(key, { key, packageName: key, path: null, valid: false });
    }
  }
  return map;
}

function collectManifestDependencies(doc) {
  const rows = [];
  const addSection = (table, kind) => {
    if (!isPlain(table)) return;
    for (const key of Object.keys(table).sort(compare)) rows.push({ key, spec: table[key], kind });
  };
  addSection(doc.dependencies, 'dependency');
  addSection(doc['dev-dependencies'], 'dev-dependency');
  addSection(doc['build-dependencies'], 'build-dependency');
  if (isPlain(doc.target)) {
    for (const targetKey of Object.keys(doc.target).sort(compare)) {
      const section = doc.target[targetKey];
      if (!isPlain(section)) continue;
      addSection(section.dependencies, 'dependency');
      addSection(section['dev-dependencies'], 'dev-dependency');
      addSection(section['build-dependencies'], 'build-dependency');
    }
  }
  return rows;
}

function resolveMemberDirs(rootDoc, manifestDirs, unknown) {
  const workspace = rootDoc.workspace;
  if (!isPlain(workspace) || !Array.isArray(workspace.members)) {
    unknown('workspace', 'Cargo.toml', 'missing-cargo-workspace');
    return [];
  }
  const excludes = [];
  if (workspace.exclude !== undefined) {
    if (!Array.isArray(workspace.exclude)) {
      unknown('workspace', 'Cargo.toml', 'invalid-workspace-config');
      return [];
    }
    for (const item of workspace.exclude) {
      const normalized = normalizeMemberPattern(item);
      if (normalized === null) {
        unknown('workspace', 'Cargo.toml', 'unsafe-path');
        continue;
      }
      excludes.push(normalized);
    }
  }
  const isExcluded = dir => excludes.some(pattern => matchesMemberPattern(pattern, dir));
  const selected = new Set();
  for (const item of workspace.members) {
    const pattern = normalizeMemberPattern(item);
    if (pattern === null) {
      unknown('workspace', 'Cargo.toml', 'unsafe-path');
      continue;
    }
    if (!pattern.includes('*') && !pattern.includes('?')) {
      if (!manifestDirs.has(pattern)) unknown('workspace', 'Cargo.toml', 'missing-workspace-member');
      else if (!isExcluded(pattern)) selected.add(pattern);
      continue;
    }
    for (const dir of manifestDirs.keys()) {
      if (matchesMemberPattern(pattern, dir) && !isExcluded(dir)) selected.add(dir);
    }
  }
  if (isPlain(rootDoc.package) && !isExcluded('')) selected.add('');
  return [...selected].sort(compare);
}

function resolveDependencySpec({ crate, dep, workspaceDeps, crateByDir, unknown }) {
  const { key, spec, kind } = dep;
  if (typeof spec === 'string') {
    return {
      from: crate.name,
      to: null,
      externalCrate: key,
      kind,
      specifier: key,
      manifest: crate.manifest,
      targetManifest: null,
      workspaceInherited: false,
    };
  }
  if (!isPlain(spec)) {
    unknown('dependency', crate.manifest, 'invalid-dependency-spec');
    return null;
  }
  if (spec.workspace === true) {
    const inherited = workspaceDeps.get(key);
    if (!inherited || !inherited.valid) {
      unknown('dependency', crate.manifest, 'unresolved-workspace-dependency');
      return null;
    }
    if (inherited.path !== null) {
      const targetDir = resolveRelativeDir('', inherited.path);
      if (targetDir === null) {
        unknown('dependency', 'Cargo.toml', 'unsafe-path');
        return null;
      }
      const target = crateByDir.get(targetDir);
      if (!target) {
        unknown('dependency', crate.manifest, 'out-of-workspace-dependency');
        return null;
      }
      return {
        from: crate.name,
        to: target.name,
        externalCrate: null,
        kind,
        specifier: key,
        manifest: crate.manifest,
        targetManifest: target.manifest,
        workspaceInherited: true,
      };
    }
    const extName =
      typeof spec.package === 'string' && spec.package.trim() ? spec.package.trim() : inherited.packageName;
    return {
      from: crate.name,
      to: null,
      externalCrate: extName,
      kind,
      specifier: key,
      manifest: crate.manifest,
      targetManifest: null,
      workspaceInherited: true,
    };
  }
  if (spec.workspace !== undefined && typeof spec.workspace !== 'boolean') {
    unknown('dependency', crate.manifest, 'invalid-dependency-spec');
    return null;
  }
  if (spec.path !== undefined) {
    if (typeof spec.path !== 'string') {
      unknown('dependency', crate.manifest, 'invalid-dependency-spec');
      return null;
    }
    const targetDir = resolveRelativeDir(crate.root, spec.path);
    if (targetDir === null) {
      unknown('dependency', crate.manifest, 'unsafe-path');
      return null;
    }
    const target = crateByDir.get(targetDir);
    if (!target) {
      unknown('dependency', crate.manifest, 'out-of-workspace-dependency');
      return null;
    }
    return {
      from: crate.name,
      to: target.name,
      externalCrate: null,
      kind,
      specifier: key,
      manifest: crate.manifest,
      targetManifest: target.manifest,
      workspaceInherited: false,
    };
  }
  const extName = typeof spec.package === 'string' && spec.package.trim() ? spec.package.trim() : key;
  return {
    from: crate.name,
    to: null,
    externalCrate: extName,
    kind,
    specifier: key,
    manifest: crate.manifest,
    targetManifest: null,
    workspaceInherited: false,
  };
}

/**
 * Pure offline Cargo workspace parser over a tracked file inventory and Cargo.toml blobs.
 * Never spawns `cargo` or touches the network.
 * @param {{ files: Array<{ path: string, mode: string, oid: string }>, contents: Map<string, Buffer | string> }} input
 */
export function parseCargoWorkspace({ files, contents }) {
  const unsupported = new Map();
  const unknown = (scope, file, reason, offset = null) => {
    const id = hash([scope, file, reason, offset]);
    unsupported.set(id, { id, scope, file, reason, offset });
  };
  const regular = entry => entry.mode === '100644' || entry.mode === '100755';
  const manifestDirs = new Map();
  for (const entry of files) {
    if (!regular(entry)) continue;
    if (entry.path === 'Cargo.toml' || entry.path.endsWith('/Cargo.toml')) {
      const dir = path.posix.dirname(entry.path);
      manifestDirs.set(dir === '.' ? '' : dir, entry.path);
    }
  }
  const rootRaw = contents.get('Cargo.toml');
  if (!manifestDirs.has('') || rootRaw === undefined) {
    unknown('workspace', 'Cargo.toml', 'missing-cargo-workspace');
    return { rootManifestHash: null, crates: [], edges: [], unsupported: [...unsupported.values()] };
  }
  const decodedRoot = decodeUtf8(rootRaw);
  if (!decodedRoot) {
    unknown('manifest', 'Cargo.toml', 'parse-error', 0);
    return { rootManifestHash: null, crates: [], edges: [], unsupported: [...unsupported.values()] };
  }
  const rootManifestHash = digest(decodedRoot.bytes);
  let rootDoc;
  try {
    rootDoc = parseToml(decodedRoot.text);
  } catch {
    unknown('manifest', 'Cargo.toml', 'parse-error', 0);
    return { rootManifestHash, crates: [], edges: [], unsupported: [...unsupported.values()] };
  }
  const memberDirs = resolveMemberDirs(rootDoc, manifestDirs, unknown);
  const workspaceDeps = parseWorkspaceDependencies(rootDoc.workspace?.dependencies);
  const crates = [];
  const crateByDir = new Map();
  const crateByName = new Map();
  const docs = new Map();
  for (const dir of memberDirs) {
    const manifest = dir ? `${dir}/Cargo.toml` : 'Cargo.toml';
    const raw = contents.get(manifest);
    const decoded = raw === undefined ? null : decodeUtf8(raw);
    if (!decoded) {
      unknown('manifest', manifest, 'parse-error', 0);
      continue;
    }
    let doc;
    try {
      doc = dir === '' ? rootDoc : parseToml(decoded.text);
    } catch {
      unknown('manifest', manifest, 'parse-error', 0);
      continue;
    }
    const name = typeof doc.package?.name === 'string' ? doc.package.name.trim() : '';
    if (!name) {
      unknown('manifest', manifest, 'invalid-crate-manifest');
      continue;
    }
    if (crateByName.has(name)) {
      unknown('workspace', manifest, 'duplicate-crate-name');
      continue;
    }
    const crate = {
      name,
      root: dir,
      manifest,
      manifestHash: digest(decoded.bytes),
      files: [],
    };
    crates.push(crate);
    crateByDir.set(dir, crate);
    crateByName.set(name, crate);
    docs.set(name, doc);
  }
  const sortedDirs = [...crateByDir.keys()].sort((a, b) => b.length - a.length || compare(a, b));
  for (const entry of files) {
    if (!regular(entry)) continue;
    const ownerDir = sortedDirs.find(dir => (dir ? entry.path === dir || entry.path.startsWith(`${dir}/`) : true));
    if (ownerDir !== undefined) crateByDir.get(ownerDir).files.push(entry.path);
  }
  for (const crate of crates) crate.files.sort(compare);
  const edges = [];
  for (const crate of crates) {
    const doc = docs.get(crate.name);
    for (const dep of collectManifestDependencies(doc)) {
      const edge = resolveDependencySpec({ crate, dep, workspaceDeps, crateByDir, unknown });
      if (edge) edges.push(edge);
    }
  }
  crates.sort((a, b) => compare(a.name, b.name));
  edges.sort(
    (a, b) =>
      compare(a.from, b.from) ||
      compare(a.kind, b.kind) ||
      compare(a.specifier, b.specifier) ||
      compare(a.to ?? a.externalCrate ?? '', b.to ?? b.externalCrate ?? ''),
  );
  return {
    rootManifestHash,
    crates,
    edges,
    unsupported: [...unsupported.values()].sort(
      (a, b) => compare(a.file ?? '', b.file ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.id, b.id),
    ),
  };
}

/**
 * Build a schemaVersion 2 Rust architecture graph from immutable Git snapshot data.
 * @param {{
 *   headSha: string,
 *   policy: Record<string, any>,
 *   files: Array<{ path: string, mode: string, oid: string }>,
 *   contents: Map<string, Buffer | string>,
 *   treeUnsupported?: Array<Record<string, any>>,
 * }} input
 */
export function buildRustArchitectureGraph({ headSha, policy, files, contents, treeUnsupported = [] }) {
  const parsed = parseCargoWorkspace({ files, contents });
  const layerOf = new Map();
  for (const [index, layer] of policy.layers.entries()) {
    for (const crateName of layer.crates) layerOf.set(crateName, { id: layer.id, index });
  }
  const contracts = new Set(policy.contractCrates);
  const crates = parsed.crates.map(crate => {
    const assigned = layerOf.get(crate.name) ?? null;
    return {
      ...crate,
      layer: assigned?.id ?? null,
      layerIndex: assigned?.index ?? null,
      isContract: contracts.has(crate.name),
    };
  });
  const nodes = new Map();
  for (const crate of crates) {
    nodes.set(`crate:${crate.name}`, {
      id: `crate:${crate.name}`,
      kind: 'crate',
      path: crate.manifest,
      root: crate.root,
      module: crate.name,
      layer: crate.layer,
      sourceHash: crate.manifestHash,
      exports: [],
      public: crate.isContract,
    });
  }
  const edges = [];
  const seenEdges = new Set();
  for (const [index, edge] of parsed.edges.entries()) {
    const from = `crate:${edge.from}`;
    const to = edge.to ? `crate:${edge.to}` : `external:${edge.externalCrate}`;
    const id = hash([from, to, edge.kind, edge.specifier, edge.workspaceInherited]);
    if (seenEdges.has(id)) continue;
    seenEdges.add(id);
    if (edge.externalCrate && !nodes.has(to)) {
      nodes.set(to, {
        id: to,
        kind: 'external',
        path: null,
        root: null,
        module: null,
        layer: null,
        sourceHash: null,
        exports: [],
        public: false,
      });
    }
    edges.push({
      id,
      from,
      to,
      kind: edge.kind,
      specifier: edge.specifier,
      offset: index,
      workspaceInherited: edge.workspaceInherited,
    });
  }
  const unsupportedMap = new Map();
  for (const item of [...treeUnsupported, ...parsed.unsupported]) unsupportedMap.set(item.id, item);
  return {
    schemaVersion: 2,
    language: 'rust',
    headSha,
    sourceHash: hash(files),
    policyHash: hash(policy),
    productRoots: policy.productRoots,
    rootManifestHash: parsed.rootManifestHash,
    files,
    modules: crates.map(crate => ({
      id: crate.name,
      roots: crate.root ? [crate.root] : ['.'],
      layer: crate.layer,
      public: [],
    })),
    crates,
    nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
    edges: edges.sort((a, b) => compare(a.from, b.from) || a.offset - b.offset || compare(a.id, b.id)),
    unsupported: [...unsupportedMap.values()].sort(
      (a, b) => compare(a.file ?? '', b.file ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.id, b.id),
    ),
  };
}
