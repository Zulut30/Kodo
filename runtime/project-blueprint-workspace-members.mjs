// Only resolve membership for packages whose identity can affect this blueprint.
// Follow local dependencies only when a direct declaration cannot settle it.
import { parse as parseToml } from 'smol-toml';
import {
  cargoPackageTable,
  collectManifestDependencies,
  compileCargoGlob,
  normalizeWorkspacePath,
  parseWorkspaceDependencies,
  resolveDepTargetDir,
  resolvePackageEdition,
  resolveRelativeDir,
} from './cargo-workspace.mjs';
import { readBlueprintCargoTree, readOptionalBlueprintMetadata } from './project-blueprint-io.mjs';
import { pathParents } from './project-blueprint-scope-index.mjs';
import { BLUEPRINT_LIMITS, failure, isPlain } from './project-blueprint-shared.mjs';

const manifestFile = dir => (dir ? dir + '/Cargo.toml' : 'Cargo.toml');
const hasGlob = pattern => /[*?[]/.test(pattern);
const isWithin = (root, dir) => !root || dir === root || dir.startsWith(root + '/');
const joinDir = (dir, path) => (dir && path ? dir + '/' + path : dir || path);

// Resolve the literal prefix against the project boundary before using a
// Cargo member glob. No parent segment reaches a tree walk or Git pathspec.
function memberPattern(root, raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  const parts = raw.trim().split('/');
  const end = parts.lastIndexOf('..') + 1;
  const base = end ? resolveRelativeDir(root, parts.slice(0, end).join('/')) : root;
  const suffix = end ? parts.slice(end).filter(Boolean).join('/') || '.' : raw;
  const pattern = normalizeWorkspacePath(suffix, { allowGlob: true });
  return base === null || pattern === null ? null : joinDir(base, pattern);
}

export function blueprintManifestReader(root, revision, tree) {
  const docs = new Map();
  const blobs = new Map();
  const known = new Set([...tree.manifests.keys()].map(dir => (dir === '.' ? '' : dir)));

  async function discover(patterns) {
    const scopes = new Set(patterns.map(manifestFile));
    const extra = await readBlueprintCargoTree(root, scopes, revision);
    for (const dir of extra.manifests.keys()) known.add(dir === '.' ? '' : dir);
    return known;
  }

  async function read(dirs) {
    const missing = [...new Set(dirs)].filter(dir => !docs.has(dir));
    if (!missing.length) return;
    // A path dependency can be outside every blueprint search lead. Git only
    // resolves entries inside the tree. On disk also verify its parent path
    // through the link-free directory walk before opening the manifest.
    const unknown = missing.filter(dir => !known.has(dir));
    if (!revision && unknown.length) await discover(unknown);
    const files = missing.filter(dir => revision || known.has(dir)).map(manifestFile);
    const parsed = await readOptionalBlueprintMetadata(
      root,
      files,
      BLUEPRINT_LIMITS.project,
      revision,
      parseToml,
      blobs,
    );
    for (const dir of missing) docs.set(dir, parsed.get(manifestFile(dir)));
  }
  return { docs, read, discover };
}

function workspaceRules(root, rootDoc) {
  const ws = isPlain(rootDoc.workspace) ? rootDoc.workspace : null;
  const declared = (Array.isArray(ws?.members) ? ws.members : [])
    .map(item => memberPattern(root, item))
    .filter(pattern => pattern !== null);
  const literal = new Set(declared.filter(pattern => !hasGlob(pattern)));
  const globPatterns = declared.filter(hasGlob);
  const globs = globPatterns.flatMap(pattern => {
    const matcher = compileCargoGlob(pattern);
    const name = pattern.slice(pattern.lastIndexOf('/') + 1);
    return matcher ? [{ matcher, namesMember: /[^*?]/.test(name) }] : [];
  });
  // Cargo compares excludes as literal subtree prefixes under this root.
  const excluded = (Array.isArray(ws?.exclude) ? ws.exclude : [])
    .map(item => normalizeWorkspacePath(item))
    .filter(pattern => pattern !== null)
    .map(pattern => joinDir(root, pattern));
  const isExcluded = dir => excluded.some(path => isWithin(path, dir));
  const allows = dir => dir === root || (ws !== null && (literal.has(dir) || !isExcluded(dir)));
  // A catch-all member glob alone does not establish the type of an absent
  // source or manifest. A literal member or a named pattern such as *.rs can.
  const matchesGlob = (dir, requireName = false) =>
    !isExcluded(dir) && globs.some(({ matcher, namesMember }) => (!requireName || namesMember) && matcher.test(dir));
  const declares = (dir, requireName = false) => literal.has(dir) || matchesGlob(dir, requireName);
  return { ws, literal, globPatterns, isExcluded, allows, matchesGlob, declares };
}

function* enclosingWorkspaces(dir, workspaces) {
  if (dir && workspaces.has(dir)) yield dir;
  for (const parent of pathParents(dir)) if (workspaces.has(parent)) yield parent;
  if (workspaces.has('')) yield '';
}

async function loadWorkspaceRules(reader, workspaces, roots) {
  const unread = [...roots].filter(root => workspaces.has(root) && workspaces.get(root) === undefined);
  await reader.read(unread);
  for (const root of unread) {
    const doc = reader.docs.get(root);
    workspaces.set(root, doc ? workspaceRules(root, doc) : null);
  }
}

export async function readBlueprintWorkspaces(reader, roots, selected, tree) {
  // null is a planned scaffold. Defer sibling roots until a package points at
  // one or its membership could affect a decision in the plan.
  const workspaces = new Map([...roots].map(root => [root, tree.manifests.has(root || '.') ? undefined : null]));
  const needed = new Set();
  for (const dir of selected) {
    for (const root of enclosingWorkspaces(dir, workspaces)) needed.add(root);
  }
  await loadWorkspaceRules(reader, workspaces, needed);
  return workspaces;
}

// A package with a possible enclosing owner can supply its name and binding
// directly. For any other package, first look for an edge from a sibling.
export function mayHaveWorkspaceOwner(dir, workspaces, needsOwner) {
  for (const root of enclosingWorkspaces(dir, workspaces)) {
    const rules = workspaces.get(root);
    if ((!rules || rules.allows(dir)) && needsOwner(root)) return true;
  }
  return false;
}

function scaffoldWorkspace(dir, workspaces) {
  let fallback;
  for (const root of enclosingWorkspaces(dir, workspaces)) {
    const rules = workspaces.get(root);
    if (rules?.ws) {
      if (fallback === undefined) return root;
      return !workspaces.get(fallback) || !rules.allows(dir) ? fallback : root;
    }
    fallback ??= root;
  }
  return fallback;
}

function eligibleMember(dir, doc, root) {
  const pkg = cargoPackageTable(doc);
  if (!pkg || (dir !== root && isPlain(doc.workspace))) return false;
  return pkg.workspace === undefined ? isWithin(root, dir) : resolveRelativeDir(dir, pkg.workspace) === root;
}

function memberEdition(dir, doc, ws) {
  const { edition, error } = resolvePackageEdition(doc, ws?.package);
  if (error === 'invalid-crate-manifest')
    throw failure(
      'blueprint_cargo_evidence_unavailable',
      `${manifestFile(dir)}: таблица [project] недопустима для этой редакции Rust`,
    );
  return edition ?? '2015';
}

async function reachablePackages(reader, rules, root, candidates, needsPath) {
  const { ws, literal, globPatterns, matchesGlob, declares, allows } = rules;
  const rootDoc = reader.docs.get(root);
  const reached = new Set();
  if (candidates.has(root) && cargoPackageTable(rootDoc)) reached.add(root);
  const pending = new Set();
  for (const dir of candidates) {
    if (dir === root || !allows(dir)) continue;
    if (declares(dir)) reached.add(dir);
    else if (needsPath(dir)) pending.add(dir);
  }
  if (!pending.size) return reached;
  // Only a path dependency can still make a candidate a member. Start at
  // the root package and declared members, following Cargo's dependency
  // tables (including inherited paths and edition-specific table aliases).
  const frontier = new Set(literal);
  if (cargoPackageTable(rootDoc)) frontier.add(root);
  if (globPatterns.length) {
    for (const dir of await reader.discover(globPatterns)) if (matchesGlob(dir)) frontier.add(dir);
  }
  const dependencies = parseWorkspaceDependencies(ws?.dependencies);
  const visited = new Set();
  while (frontier.size && pending.size) {
    // A manifest already read for a write scope can prove a dependency
    // before any other package body is needed.
    const cached = [...frontier].filter(dir => reader.docs.has(dir));
    const batch = cached.length ? cached : [...frontier];
    await reader.read(batch);
    for (const dir of batch) {
      frontier.delete(dir);
      visited.add(dir);
      const doc = reader.docs.get(dir);
      if (!eligibleMember(dir, doc, root)) continue;
      for (const dep of collectManifestDependencies(doc, { edition: memberEdition(dir, doc, ws) })) {
        const target = resolveDepTargetDir(dep, dir, root, dependencies, '');
        if (target === null || !allows(target)) continue;
        if (pending.delete(target)) reached.add(target);
        if (!visited.has(target)) frontier.add(target);
      }
    }
  }
  return reached;
}

async function reachableWorkspaceCandidates(reader, workspaces, root, local, deferred, upperCount, needsPath) {
  const rules = workspaces.get(root);
  if (rules === null) return []; // A planned scaffold cannot enroll a sibling.
  const outside = root && (!rules || rules.ws) ? deferred.filter(dir => !isWithin(root, dir)) : [];
  const possibleSiblings = () => {
    const possible = outside.filter(dir => !reader.docs.has(dir) || eligibleMember(dir, reader.docs.get(dir), root));
    const upper = upperCount(possible);
    return possible.filter(dir => needsPath(dir, upper));
  };
  const reach = async siblings => {
    if (!local.size && !siblings.length) return [];
    await loadWorkspaceRules(reader, workspaces, [root]);
    const resolved = workspaces.get(root);
    if (!resolved) return [];
    const upper = upperCount(siblings);
    return reachablePackages(reader, resolved, root, new Set([...local, ...siblings]), dir => needsPath(dir, upper));
  };
  const siblings = possibleSiblings();
  try {
    return await reach(siblings);
  } catch (error) {
    if (!siblings.length || error?.code !== 'blueprint_cargo_evidence_unavailable') throw error;
    // An unreadable source might only be needed to reach an unrelated target.
    // Its target's name or package.workspace can independently rule it out.
    await reader.read(siblings);
    const remaining = possibleSiblings();
    if (remaining.length === siblings.length) throw error;
    return reach(remaining);
  }
}

export async function blueprintWorkspaceOwners(
  reader,
  workspaces,
  { existing, siblings, future, planned, needsPath, writesManifest },
) {
  const owners = new Map();
  const queries = new Map();
  const fallbacks = new Map();
  const bindings = new Map();
  for (const dir of existing) {
    const explicit = cargoPackageTable(reader.docs.get(dir))?.workspace;
    bindings.set(dir, explicit === undefined ? undefined : resolveRelativeDir(dir, explicit));
  }
  await loadWorkspaceRules(reader, workspaces, new Set(bindings.values()));
  const query = (root, dir) => {
    if (!queries.has(root)) queries.set(root, new Set());
    queries.get(root).add(dir);
  };
  // Cargo can list the same directory from two manifest-root invocations.
  // Each root must declare or reach it independently. Use a planned
  // scaffold only if none of the real workspaces claims the package.
  for (const [dir, binding] of bindings) {
    const doc = reader.docs.get(dir);
    const roots = binding === undefined ? enclosingWorkspaces(dir, workspaces) : [binding];
    let fallback;
    let hasWorkspace = false;
    for (const root of roots) {
      const rules = workspaces.get(root);
      if (rules?.ws) {
        hasWorkspace = true;
        if (rules.allows(dir) && eligibleMember(dir, doc, root)) query(root, dir);
      } else if (!hasWorkspace && binding === undefined && (!rules || dir === root)) {
        fallback ??= root;
      }
    }
    if (fallback !== undefined) {
      if (!hasWorkspace && workspaces.get(fallback)) query(fallback, dir);
      else fallbacks.set(dir, fallback);
    }
  }
  // No package body or dependency edge can establish membership yet. A new
  // package can match current members, or the scaffold can extend the manifest.
  const manifestEdits = new Map();
  for (const dir of future) {
    const declared = [...enclosingWorkspaces(dir, workspaces)].filter(root => workspaces.get(root)?.declares(dir));
    if (declared.length) {
      owners.set(dir, declared);
      continue;
    }
    const root = scaffoldWorkspace(dir, workspaces);
    if (root === undefined) continue;
    const rules = workspaces.get(root);
    if (rules && dir !== root) {
      if (rules.isExcluded(dir)) continue;
      if (!manifestEdits.has(root)) manifestEdits.set(root, writesManifest(root));
      if (!manifestEdits.get(root)) continue;
    }
    owners.set(dir, [root]);
  }
  // Before following dependencies, bound each workspace's possible Wave 0
  // count. Packages in another workspace cannot push this one over the limit.
  const counts = new Map();
  const count = (dir, root) => {
    if (planned.has(dir)) counts.set(root, (counts.get(root) ?? 0) + 1);
  };
  for (const [dir, roots] of owners) for (const root of roots) count(dir, root);
  for (const [dir, root] of fallbacks) count(dir, root);
  for (const [root, candidates] of queries) for (const dir of candidates) count(dir, root);
  const matters = (dir, root, upper = counts.get(root) ?? 0) => root !== undefined && needsPath(dir, root, upper);
  for (const root of workspaces.keys()) {
    const reachable = await reachableWorkspaceCandidates(
      reader,
      workspaces,
      root,
      queries.get(root) ?? new Set(),
      siblings,
      possible => (counts.get(root) ?? 0) + possible.filter(dir => planned.has(dir)).length,
      (dir, upper) => matters(dir, root, upper) || matters(dir, fallbacks.get(dir)),
    );
    // Check package.workspace only for targets the root actually reaches.
    await reader.read(reachable);
    for (const dir of reachable) {
      const doc = reader.docs.get(dir);
      if (!eligibleMember(dir, doc, root)) continue;
      if (doc.project !== undefined) memberEdition(dir, doc, workspaces.get(root).ws);
      if (!owners.has(dir)) owners.set(dir, []);
      owners.get(dir).push(root);
    }
  }
  for (const [dir, root] of fallbacks) if (!owners.has(dir)) owners.set(dir, [root]);
  return owners;
}
