/** Offline Cargo workspace parser and Rust crate graph builder for Architecture Guardian. */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import {
  collectManifestDependencies,
  decodeUtf8,
  isPlainObject,
  resolveCargoWorkspace,
  resolveRelativeDir,
} from './cargo-workspace.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function canonical(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  throw Object.assign(new Error('Architecture Rust graph: configuration'), { code: 'configuration' });
}
const hash = value => digest(JSON.stringify(canonical(value)));

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
  if (!isPlainObject(spec)) {
    unknown('dependency', crate.manifest, 'invalid-dependency-spec');
    return null;
  }
  if (spec.workspace === true) {
    if (spec.package !== undefined) {
      unknown('dependency', crate.manifest, 'conflicting-workspace-package');
      return null;
    }
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
    return {
      from: crate.name,
      to: null,
      externalCrate: inherited.packageName,
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

const isCargoConfigFile = file =>
  file === '.cargo/config.toml' ||
  file === '.cargo/config' ||
  file.endsWith('/.cargo/config.toml') ||
  file.endsWith('/.cargo/config');

function checkUnsupportedOverrides({ files, contents, rootDoc, unknown }) {
  if (rootDoc?.patch !== undefined) unknown('workspace', 'Cargo.toml', 'unsupported-cargo-patch');
  if (rootDoc?.replace !== undefined) unknown('workspace', 'Cargo.toml', 'unsupported-cargo-replace');
  for (const entry of files) {
    if ((entry.mode !== '100644' && entry.mode !== '100755') || !isCargoConfigFile(entry.path)) continue;
    const raw = contents.get(entry.path);
    const decoded = raw === undefined ? null : decodeUtf8(raw);
    if (!decoded) {
      unknown('workspace', entry.path, 'parse-error', 0);
      continue;
    }
    let doc;
    try {
      doc = parseToml(decoded.text);
    } catch {
      unknown('workspace', entry.path, 'parse-error', 0);
      continue;
    }
    if (doc?.patch !== undefined) unknown('workspace', entry.path, 'unsupported-cargo-patch');
    if (doc?.replace !== undefined) unknown('workspace', entry.path, 'unsupported-cargo-replace');
    if (doc?.include !== undefined) unknown('workspace', entry.path, 'unsupported-cargo-config-include');
  }
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
  const manifests = new Map();
  const trackedFiles = [];
  for (const entry of files) {
    if (!regular(entry)) continue;
    trackedFiles.push(entry.path);
    if (entry.path === 'Cargo.toml' || entry.path.endsWith('/Cargo.toml')) {
      const raw = contents.get(entry.path);
      if (raw !== undefined) manifests.set(entry.path, raw);
    }
  }
  const resolved = resolveCargoWorkspace({ manifests, files: trackedFiles, startDir: '' });
  for (const item of resolved.unsupported) unsupported.set(item.id, item);
  checkUnsupportedOverrides({ files, contents, rootDoc: resolved.rootDoc, unknown });
  if (!resolved.hasWorkspace) {
    if (!unsupported.size) unknown('workspace', 'Cargo.toml', 'missing-cargo-workspace');
    return {
      rootManifestHash: resolved.rootManifestHash,
      crates: [],
      edges: [],
      unsupported: [...unsupported.values()].sort(
        (a, b) => compare(a.file ?? '', b.file ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.id, b.id),
      ),
    };
  }
  const crates = [];
  const crateByDir = new Map();
  const docs = new Map();
  const editions = new Map();
  for (const member of resolved.members) {
    const crate = {
      name: member.name,
      root: member.root,
      manifest: member.manifest,
      manifestHash: member.manifestHash,
      files: [],
    };
    crates.push(crate);
    crateByDir.set(member.root, crate);
    docs.set(member.name, member.doc);
    editions.set(member.name, member.edition ?? '2015');
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
    for (const dep of collectManifestDependencies(doc, {
      edition: editions.get(crate.name),
      onUnsupported: reason => unknown('manifest', crate.manifest, reason),
    })) {
      const edge = resolveDependencySpec({
        crate,
        dep,
        workspaceDeps: resolved.workspaceDependencies,
        crateByDir,
        unknown,
      });
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
    rootManifestHash: resolved.rootManifestHash,
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
