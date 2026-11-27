// Only resolve membership for packages whose identity can affect this blueprint.
// Follow local dependencies only when a direct declaration cannot settle it.
import { parse as parseToml } from 'smol-toml';
import path from 'node:path';
import { CargoDirectoryNames, cargoMemberMatcher, cargoNameKey, hasCargoGlob } from './cargo-member-paths.mjs';
import {
  cargoPackageTable,
  collectManifestDependencies,
  parseWorkspaceDependencies,
  resolveDepTargetDir,
  resolveManifestDir,
  resolvePackageEdition,
  workspaceExclusionMatcher,
  workspaceMemberPattern,
} from './cargo-workspace.mjs';
import {
  blueprintChildDirectories,
  blueprintPathAliasProbe,
  readBlueprintCargoTree,
  readOptionalBlueprintMetadata,
} from './project-blueprint-io.mjs';
import { pathAndAncestors } from './scope-paths.mjs';
import { BLUEPRINT_LIMITS, failure, isPlain } from './project-blueprint-shared.mjs';

const manifestFile = dir => (dir ? dir + '/Cargo.toml' : 'Cargo.toml');
const isWithin = (root, dir) => !root || dir === root || dir.startsWith(root + '/');
const malformedManifest = Symbol('malformed Cargo.toml');

function parseManifest(text) {
  try {
    return parseToml(text);
  } catch {
    return malformedManifest;
  }
}

export function blueprintManifestReader(root, revision, tree) {
  const docs = new Map();
  const blobs = new Map();
  const known = new Set([...tree.manifests.keys()].map(dir => (dir === '.' ? '' : dir)));
  const names = new CargoDirectoryNames(known, blueprintPathAliasProbe(root));
  const listed = new Set();

  async function nativeLead(pattern) {
    if (path.sep !== '\\' || names.paths.has(pattern)) return pattern;
    const parts = pattern.split('/');
    let parent = '';
    for (const [i, part] of parts.entries()) {
      if (hasCargoGlob(part)) break;
      const requested = parent ? parent + '/' + part : part;
      if (!names.paths.has(requested) && !listed.has(parent)) {
        for (const child of await blueprintChildDirectories(root, parent, revision)) names.add(child);
        listed.add(parent);
      }
      const stored = names.resolve(requested);
      if (!names.paths.has(stored)) break;
      parts[i] = stored.slice(stored.lastIndexOf('/') + 1);
      parent = stored;
    }
    return parts.join('/');
  }

  async function discover(patterns) {
    const scopes = new Set();
    for (const pattern of patterns) scopes.add(manifestFile(await nativeLead(pattern)));
    const extra = await readBlueprintCargoTree(root, scopes, revision);
    for (const dir of extra.manifests.keys()) {
      const stored = dir === '.' ? '' : dir;
      known.add(stored);
      names.add(stored);
    }
    return known;
  }

  async function read(dirs, optionalSources = undefined) {
    const missing = [...new Set(dirs)].filter(dir => !docs.has(dir));
    if (!missing.length) return;
    // A path dependency can be outside every blueprint search lead. Git only
    // resolves entries inside the tree. On disk also verify its parent path
    // through the link-free directory walk before opening the manifest.
    const stored = new Map();
    for (const dir of missing) stored.set(dir, known.has(dir) ? dir : await nativeLead(dir));
    const unknown = [...new Set(stored.values())].filter(dir => !known.has(dir));
    if (!revision && unknown.length) await discover(unknown);
    const files = [...new Set(stored.values())].filter(dir => revision || known.has(dir)).map(manifestFile);
    const parsed = await readOptionalBlueprintMetadata(
      root,
      files,
      BLUEPRINT_LIMITS.project,
      revision,
      revision && optionalSources ? parseManifest : parseToml,
      blobs,
    );
    for (const [dir, actual] of stored) {
      const doc = parsed.get(manifestFile(actual));
      if (doc === malformedManifest) {
        if (optionalSources?.has(dir)) continue;
        throw failure(
          'blueprint_cargo_evidence_unavailable',
          `Не удалось разобрать ${manifestFile(actual)} в выбранном коммите Git`,
        );
      }
      docs.set(actual, doc);
      docs.set(dir, doc);
    }
  }
  return { docs, read, discover, names };
}

function workspaceRules(root, rootDoc, names) {
  const ws = isPlain(rootDoc.workspace) ? rootDoc.workspace : null;
  const declared = (Array.isArray(ws?.members) ? ws.members : [])
    .map(item => workspaceMemberPattern(root, item))
    .filter(pattern => pattern !== null);
  const literal = new Set(declared.filter(pattern => !hasCargoGlob(pattern)));
  const byName = Map.groupBy(literal, cargoNameKey);
  const globPatterns = declared.filter(hasCargoGlob);
  const globs = globPatterns.flatMap(pattern => {
    const matcher = cargoMemberMatcher(pattern, names);
    const name = pattern.slice(pattern.lastIndexOf('/') + 1);
    return matcher ? [{ matcher, namesMember: /[^*?]/.test(name) }] : [];
  });
  const excludedSpelling = workspaceExclusionMatcher(root, ws);
  // A catch-all member glob alone does not establish the type of an absent
  // source or manifest. A literal member or a named pattern such as *.rs can.
  function* spellings(dir, requireName = false) {
    for (const spelled of byName.get(cargoNameKey(dir)) ?? [])
      if (names.samePath(dir, spelled) && !excludedSpelling(spelled)) yield spelled;
    for (const { matcher, namesMember } of globs) {
      if (requireName && !namesMember) continue;
      for (const spelled of matcher.spellings(dir)) if (!excludedSpelling(spelled)) yield spelled;
    }
  }
  const declares = (dir, requireName = false) => !spellings(dir, requireName).next().done;
  const isExcluded = dir => excludedSpelling(dir) && !declares(dir);
  const allows = dir => dir === root || (ws !== null && !isExcluded(dir));
  // On Windows a dependency can name even an excluded sibling through a
  // native alias. Only the spelling of its actual edge settles membership.
  const mayReach = dir => allows(dir) || path.sep === '\\';
  return { ws, literal, globPatterns, isExcluded, excludedSpelling, allows, mayReach, declares, spellings };
}

function* enclosingWorkspaces(dir, workspaces) {
  for (const parent of pathAndAncestors(dir)) if (workspaces.has(parent)) yield parent;
}

function workspaceLookupOrder(workspaces) {
  const roots = workspaces.keys();
  // A more specific workspace can supply a package.workspace binding before
  // an enclosing root needs to search its dependencies for a native alias.
  return path.sep === '\\' ? [...roots].sort((a, b) => b.length - a.length) : roots;
}

async function loadWorkspaceRules(reader, workspaces, roots) {
  const unread = [...roots].filter(root => workspaces.has(root) && workspaces.get(root) === undefined);
  await reader.read(unread);
  for (const root of unread) {
    const doc = reader.docs.get(root);
    workspaces.set(root, doc ? workspaceRules(root, doc, reader.names) : null);
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
  return pkg.workspace === undefined ? isWithin(root, dir) : resolveManifestDir(dir, pkg.workspace) === root;
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

async function reachablePackages(reader, rules, root, candidates, needsPath, requiresEdge) {
  const { ws, literal, globPatterns, declares, excludedSpelling } = rules;
  const rootDoc = reader.docs.get(root);
  const reached = new Set();
  if (candidates.has(root) && cargoPackageTable(rootDoc)) reached.add(root);
  const pending = new Set();
  for (const dir of candidates) {
    if (dir === root) continue;
    if (declares(dir)) reached.add(dir);
    else if (needsPath(dir)) pending.add(dir);
  }
  if (!pending.size) return reached;
  // Only a path dependency can still make a candidate a member. Start at
  // the root package and declared members, following Cargo's dependency
  // tables (including inherited paths and edition-specific table aliases).
  const frontier = new Set([...literal].filter(dir => !excludedSpelling(dir)));
  if (cargoPackageTable(rootDoc)) frontier.add(root);
  if (globPatterns.length) {
    for (const dir of await reader.discover(globPatterns))
      for (const spelling of rules.spellings(dir)) frontier.add(spelling);
  }
  // An excluded directory may still be named by a dependency with a native
  // alias. An otherwise unrelated malformed member declares no usable edge.
  // Once a real dependency points at a manifest its evidence is required.
  const optionalSources = [...pending].some(requiresEdge) ? undefined : new Set(frontier);
  const dependencies = parseWorkspaceDependencies(ws?.dependencies);
  const visited = new Set();
  while (frontier.size && pending.size) {
    // A manifest already read for a write scope can prove a dependency
    // before any other package body is needed.
    const cached = [...frontier].filter(dir => reader.docs.has(dir));
    const batch = cached.length ? cached : [...frontier];
    await reader.read(batch, optionalSources);
    for (const dir of batch) {
      frontier.delete(dir);
      if (reader.docs.has(dir)) visited.add(dir);
    }
    for (const dir of batch) {
      const doc = reader.docs.get(dir);
      const actual = reader.names.resolve(dir);
      if (!eligibleMember(actual, doc, root)) continue;
      for (const dep of collectManifestDependencies(doc, { edition: memberEdition(actual, doc, ws) })) {
        const spelling = resolveDepTargetDir(dep, dir, root, dependencies, '');
        if (spelling === null || excludedSpelling(spelling)) continue;
        const target = reader.names.resolve(spelling);
        if (pending.delete(target)) reached.add(target);
        optionalSources?.delete(spelling);
        if (!visited.has(spelling)) frontier.add(spelling);
      }
    }
  }
  return reached;
}

async function reachableWorkspaceCandidates(reader, workspaces, root, local, deferred, upperCount, needsPath) {
  const rules = workspaces.get(root);
  if (rules === null) return []; // A planned scaffold cannot enroll a sibling.
  const outside = deferred.filter(dir =>
    isWithin(root, dir) ? rules?.isExcluded(dir) && rules.mayReach(dir) : root && (!rules || rules.ws),
  );
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
    const candidates = new Set([...local, ...siblings]);
    let upperWithoutExcluded;
    const requiresEdge = dir => {
      if (path.sep !== '\\' || !resolved.ws?.exclude?.length) return true;
      if (resolved.isExcluded(dir)) return false;
      upperWithoutExcluded ??= upperCount(
        siblings,
        [...candidates].filter(candidate => resolved.isExcluded(candidate)),
      );
      return needsPath(dir, upperWithoutExcluded);
    };
    return reachablePackages(reader, resolved, root, candidates, dir => needsPath(dir, upper), requiresEdge);
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
    bindings.set(dir, explicit === undefined ? undefined : resolveManifestDir(dir, explicit));
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
        if (rules.mayReach(dir) && eligibleMember(dir, doc, root)) query(root, dir);
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
  const plannedCount = dirs => dirs.filter(dir => planned.has(dir)).length;
  for (const root of workspaceLookupOrder(workspaces)) {
    const reachable = await reachableWorkspaceCandidates(
      reader,
      workspaces,
      root,
      queries.get(root) ?? new Set(),
      siblings,
      (possible, excluded = []) => (counts.get(root) ?? 0) + plannedCount(possible) - plannedCount(excluded),
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
