// Rust checks of the project factory blueprint (`project-blueprint.mjs`): the
// contract crate and workspace declarations, wave zero contract policy, the
// committed toolchain and the package names of committed Cargo manifests.

import {
  blueprintScopeBranches,
  cargoPackageTable,
  expandScopeAlternatives,
  isBroadContractScope,
  isExplicitContractScope,
  normalizeScopePath,
  scopeMatchesPath,
} from './cargo-workspace.mjs';
import { FOUNDATION_ID, compare, finding, isPlain } from './project-blueprint-shared.mjs';
import {
  createPackageFileOwnerResolver,
  scopedDirectoryMatcher,
  selectedManifestRoots,
  selectsCargoManifest,
} from './project-blueprint-cargo-scopes.mjs';
import {
  blueprintManifestReader,
  blueprintWorkspaceOwners,
  mayHaveWorkspaceOwner,
  readBlueprintWorkspaces,
} from './project-blueprint-workspace-members.mjs';
import { taskAncestors } from './project-blueprint-lint.mjs';
import { blueprintWriteScopes, readBlueprintCargoTree, scopedCargoDirs } from './project-blueprint-io.mjs';
import { pathParents, scopeOwnership } from './project-blueprint-scope-index.mjs';
import { sectionLines } from './project-blueprint-spec.mjs';
import { scopeGlobSyntax } from './scope-paths.mjs';

const RUST_CONTRACT_CRATE_MIN = 3;
const CONTRACT_CRATE_NAME = /(?:^|[-_])contracts$/i;
function normalizeRelScope(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}
function conventionalCrateRoot(scope, tree = undefined) {
  let dir = '';
  let container = false;
  let crate = null;
  for (const part of scope.split('/')) {
    if (!part || part === '.' || part === '..' || scopeGlobSyntax.test(part) || (part === 'src' && dir === crate))
      break;
    const member = container && (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(part) || tree?.catalogParents?.has(dir));
    dir = dir ? dir + '/' + part : part;
    const kind = tree?.entryKinds.get(dir);
    if (kind === 'leaf' || (kind !== 'tree' && dir === scope && isCargoFile(part))) break;
    if (member) crate = dir;
    container = part === 'crates';
  }
  return crate;
}

// Cargo member declarations may name directories anywhere, including below
// src. Only concrete directory names can identify an additional future member.
function addMemberDirectories(scope, entryKinds, literal, dirs) {
  const parts = scope.split('/');
  let dir = '';
  for (const part of parts) {
    if (!part || part === '..' || part === '.' || scopeGlobSyntax.test(part)) break;
    dir = dir ? dir + '/' + part : part;
    const kind = entryKinds.get(dir);
    if (kind === 'leaf') break;
    // A terminal Cargo.toml identifies its parent; Cargo.lock is also a file
    // unless the tree or an actual descendant shows this name is a directory.
    if (
      dir === scope &&
      kind !== 'tree' &&
      ((!literal && part.includes('.')) || part === 'Cargo.toml' || part === 'Cargo.lock')
    )
      break;
    dirs.add(dir);
  }
}

function isCargoFile(name) {
  return name === 'Cargo.toml' || name === 'Cargo.lock' || name.endsWith('.rs');
}

function plannedManifestRoots(scopes, entryKinds) {
  const roots = new Set();
  let owns;
  for (const scope of scopes) {
    for (const root of selectedManifestRoots(normalizeRelScope(scope))) {
      if (!root || roots.has(root)) continue;
      const manifest = root + '/Cargo.toml';
      const blocker = [...pathParents(manifest)].find(dir => entryKinds.get(dir) === 'leaf');
      if (blocker) {
        owns ??= scopeOwnership(scopes);
        if (!owns(blocker)) continue;
      }
      roots.add(root);
    }
  }
  return roots;
}
function isRustBlueprint(spec, projectMarkdown, architecturePolicy, scopes) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return true;
  if (typeof projectMarkdown === 'string' && /\b(?:rust|cargo)\b/i.test(projectMarkdown)) return true;
  for (const scope of scopes) if (/(?:^|\/)Cargo\.toml$|\.rs$/i.test(scope.replaceAll('\\', '/'))) return true;
  const meta = [spec?.title, spec?.businessContext, ...(Array.isArray(spec?.constraints) ? spec.constraints : [])]
    .filter(Boolean)
    .join('\n');
  return /\b(?:rust|cargo)\b/i.test(meta);
}
function linesOutsideCodeFences(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        opener &&
        opener[1][0] === fence[0] &&
        opener[1].length >= fence.length &&
        !/\S/.test(line.slice(opener[0].length))
      )
        fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    out.push(line);
  }
  return out;
}
const strictDeclRe = (key, valueClass) =>
  new RegExp(
    `^ {0,3}(?:[-*]\\s+)?${key}\\s*:\\s*(?:\`(${valueClass})\`|"(${valueClass})"|'(${valueClass})'|(${valueClass}))\\s*$`,
  );
const CONTRACT_DECL_RE = strictDeclRe('contractCrate', '[A-Za-z0-9][A-Za-z0-9_./-]*');
const WORKSPACE_DECL_RE = strictDeclRe('workspaceRoot', '\\.|[A-Za-z0-9][A-Za-z0-9_./-]*');
const ROOT_PACKAGE_DECL_RE = strictDeclRe('rootPackage', '\\.|[A-Za-z0-9][A-Za-z0-9_./-]*');
function cleanDeclaredPath(raw) {
  const cleaned = raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!cleaned || /^(?:none|no|false)$/i.test(cleaned)) return null;
  if (cleaned !== '.' && cleaned.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return cleaned;
}
function collectStrictDeclarations(sources, pattern) {
  const tokens = new Set();
  for (const source of sources) {
    for (const line of linesOutsideCodeFences(source)) {
      const match = pattern.exec(line);
      if (!match) continue;
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
      const cleaned = cleanDeclaredPath(raw);
      if (cleaned) tokens.add(cleaned);
    }
  }
  return tokens;
}
function declaredContractTokens(spec, projectMarkdown) {
  const constraints = Array.isArray(spec?.constraints) ? spec.constraints : [];
  return collectStrictDeclarations([projectMarkdown, ...constraints], CONTRACT_DECL_RE);
}
function declaredRootPackages(spec, projectMarkdown) {
  const roots = new Set();
  const constraints = Array.isArray(spec?.constraints) ? spec.constraints : [];
  for (const token of collectStrictDeclarations([projectMarkdown, ...constraints], ROOT_PACKAGE_DECL_RE)) {
    roots.add(token === '.' || token === 'Cargo.toml' ? '' : token.replace(/\/Cargo\.toml$/, ''));
  }
  return roots;
}
function declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, crateDirs, scopes) {
  const roots = new Set();
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') roots.add('');
  const constraints = Array.isArray(spec?.constraints) ? spec.constraints : [];
  for (const token of collectStrictDeclarations([projectMarkdown, ...constraints], WORKSPACE_DECL_RE)) {
    roots.add(token === '.' || token === 'Cargo.toml' ? '' : token.replace(/\/Cargo\.toml$/, ''));
  }
  const crateParents = new Set();
  for (const dir of crateDirs) for (const parent of pathParents(dir)) crateParents.add(parent);
  for (const scope of scopes) {
    for (const dir of selectedManifestRoots(normalizeRelScope(scope), true))
      if (!dir || crateParents.has(dir)) roots.add(dir);
  }
  return roots;
}
function taskCreatesCompilableContractCrate(task, contractRoot) {
  let coversManifest = false;
  let coversSource = false;
  const manifestPath = contractRoot ? `${contractRoot}/Cargo.toml` : 'Cargo.toml';
  const libPath = contractRoot ? `${contractRoot}/src/lib.rs` : 'src/lib.rs';
  const srcPrefix = contractRoot ? `${contractRoot}/src/` : 'src/';
  for (const rawScope of task.writePaths ?? []) {
    if (!isExplicitContractScope(rawScope, contractRoot)) continue;
    const scope = normalizeScopePath(rawScope);
    if (scopeMatchesPath(scope, manifestPath)) coversManifest = true;
    if (scopeMatchesPath(scope, libPath) || (scope.startsWith(srcPrefix) && /\.rs$/i.test(scope))) coversSource = true;
  }
  return coversManifest && coversSource;
}
function broadContractScopeFindings(spec, contractRoots, plan, protectedOwner) {
  // Wave 0 can declare a crate that has no manifest yet. For existing crates
  // the per-scope owner already proves reachability past nested manifests.
  const futureRoots = [...contractRoots].filter(root => !plan.tree.manifests.has(root || '.'));
  if (!futureRoots.length && !plan.broadOwners.size) return [];
  const offending = new Set();
  for (const task of spec.tasks) {
    for (const scope of task.writePaths ?? []) {
      if (typeof scope !== 'string') continue;
      const owners = plan.broadOwners.get(scope.replace(/^\.\//, ''));
      if (owners?.some(protectedOwner) || futureRoots.some(root => isBroadContractScope(scope, root))) {
        offending.add(task.id);
        break;
      }
    }
  }
  if (!offending.size) return [];
  return [
    finding(
      'contract_scope_too_broad',
      'Путь записи задачи накрывает защищённый контрактный крейт слишком широкой маской; ' +
        'укажите конкретный каталог модуля или явно назовите каталог контрактного крейта в задаче контракта',
      [...offending].sort(compare),
    ),
  ];
}
function ownerWorkspaceOf(crateRoot, sortedWorkspaceRoots) {
  return sortedWorkspaceRoots.find(wsRoot =>
    wsRoot === '' ? true : crateRoot === wsRoot || crateRoot.startsWith(`${wsRoot}/`),
  );
}
function normalizePackageNames(raw) {
  const map = new Map();
  const entries = raw instanceof Map ? [...raw.entries()] : isPlain(raw) ? Object.entries(raw) : [];
  for (const [dir, name] of entries) {
    if (typeof dir !== 'string' || typeof name !== 'string' || !name.trim()) continue;
    const cleaned = dir === '' || dir === '.' ? '' : normalizeRelScope(dir);
    map.set(cleaned, name.trim());
  }
  return map;
}

// Planned Rust crates drive the Wave 0 threshold. A broad scope may also
// need an existing package name solely to check access to its non-Rust files.
function planCargoCrates(scopes, tree, candidates, admitsNested = undefined) {
  const { manifests, hints, nested, broadOwners } = candidates;
  for (const [dir, parent] of nested) if (!admitsNested?.(dir, parent)) manifests.delete(dir);
  const planned = new Set();
  const inferred = new Map();
  for (const { dir } of scopedCargoDirs(scopes, { ...tree, manifests })) {
    const root = dir === '.' ? '' : dir;
    planned.add(root);
    if (hints.has(root)) inferred.set(root, root.split('/').at(-1));
  }
  return { planned, inferred, tree, virtual: new Set(), broadOwners };
}

function cargoScopeLayout(scope, entryKinds) {
  const file = normalizeRelScope(scope);
  const kind = entryKinds.get(file);
  const literal = !scopeGlobSyntax.test(file);
  const extension = /\.([\w-]+)$/.exec(file)?.[1];
  // A non-Rust descendant can establish that a file-shaped parent is a directory.
  // Most unrelated file globs need no expansion or provisional member directories.
  const relevant =
    !extension ||
    extension === 'rs' ||
    file.endsWith('Cargo.toml') ||
    kind === 'tree' ||
    /\.(?:rs|toml|lock)[^/]*\//.test(file);
  const branches = relevant ? blueprintScopeBranches(file) : [file];
  return { branches, literal, memberHint: (relevant || literal) && (kind !== 'leaf' || !literal) };
}

function cargoPlanCandidates(scopes, tree, useMemberDeclarations = false) {
  const fileOwners = createPackageFileOwnerResolver(tree.manifests, tree.entryKinds);
  const broadOwners = new Map();
  const explicit = plannedManifestRoots(scopes, tree.entryKinds);
  const hasManifest = dir => tree.manifests.has(dir || '.') || explicit.has(dir);
  const hints = new Set(explicit);
  const conventional = new Set(explicit);
  const futureScopes = new Set();
  for (const scope of scopes) {
    const owners = Array.from(fileOwners(scope), dir => (dir === '.' ? '' : dir));
    const broad = owners.filter(root => !isExplicitContractScope(scope, root));
    if (broad.length) broadOwners.set(scope, broad);
    const dirs = new Set();
    const { branches, literal, memberHint } = cargoScopeLayout(scope, tree.entryKinds);
    for (const branch of branches) {
      const dir = conventionalCrateRoot(branch, tree);
      if (dir) {
        conventional.add(dir);
        hints.add(dir);
        dirs.add(dir);
      }
      if (useMemberDeclarations && tree.manifests.size && memberHint)
        addMemberDirectories(branch, tree.entryKinds, literal, dirs);
    }
    for (const dir of dirs) {
      if (hasManifest(dir)) continue;
      hints.add(dir);
      futureScopes.add(scope);
    }
  }
  const manifests = new Map(tree.manifests);
  const nested = new Map();
  for (const dir of explicit) if (!manifests.has(dir)) manifests.set(dir, null);
  if (futureScopes.size) {
    for (const dir of hints) if (!manifests.has(dir)) manifests.set(dir, null);
    const confirmed = new Set();
    for (const { dir } of scopedCargoDirs(futureScopes, { ...tree, manifests })) {
      if (confirmed.has(dir) || hasManifest(dir)) continue;
      confirmed.add(dir);
      // If this provisional child turns out to be a module, its source still
      // belongs to a prospective ancestor until the next actual manifest.
      for (const parent of pathParents(dir)) {
        if (hasManifest(parent)) break;
        if (hints.has(parent)) confirmed.add(parent);
      }
    }
    for (const dir of hints) {
      if (hasManifest(dir)) continue;
      if (!confirmed.has(dir)) {
        manifests.delete(dir);
        continue;
      }
      const parent = [...pathParents(dir)].find(hasManifest) ?? (hasManifest('') ? '' : undefined);
      if (parent !== undefined || !conventional.has(dir)) nested.set(dir, parent);
    }
  }
  return { manifests, nested, hints, conventional, broadOwners };
}

function directCratesMember(dir, root) {
  return dir.slice(0, dir.lastIndexOf('/')) === (root ? root + '/crates' : 'crates');
}

async function readPlannedCargoCrates(reader, tree, scopes, spec, projectMarkdown, architecturePolicy) {
  const candidates = cargoPlanCandidates(scopes, tree, true);
  if (!candidates.nested.size) return planCargoCrates(scopes, tree, candidates);
  const roots = declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, candidates.conventional, scopes);
  const workspaces = await readBlueprintWorkspaces(reader, roots, candidates.nested.keys(), tree);
  const owns = scopeOwnership(scopes);
  const fileSelectors = scopeOwnership(scopes, (choices, file) =>
    choices.some(scope => selectsCargoManifest(scope, file)),
  );
  // Cargo permits modules anywhere in a package (including #[path] targets).
  // Splitting off a source-only child requires evidence of separate membership.
  let descendsInto;
  const admitsNested = (dir, parent) => {
    let fileNameOnly = false;
    if (dir.endsWith('.rs') && !tree.entryKinds.has(dir)) {
      descendsInto ??= scopedDirectoryMatcher(scopes);
      fileNameOnly = !descendsInto(dir);
    }
    for (const rules of workspaces.values()) if (rules?.declares(dir, fileNameOnly)) return true;
    if (fileNameOnly || !candidates.conventional.has(dir) || !workspaces.has(parent)) return false;
    const rules = workspaces.get(parent);
    if (rules?.isExcluded(dir)) return false;
    // A direct crates/<name> can be added by editing the workspace manifest.
    // In an existing directory, require the plan to select the manifest file:
    // a module directory or its whole subtree does not by itself create a package.
    if (cargoPackageTable(reader.docs.get(parent))) {
      const selectsManifest = tree.entryKinds.has(dir) ? fileSelectors : owns;
      if (!directCratesMember(dir, parent) || !selectsManifest(dir + '/Cargo.toml')) return false;
    }
    return coversWorkspaceManifest(scopes, parent);
  };
  return planCargoCrates(scopes, tree, candidates, admitsNested);
}

function planCatalogCrates(scopes, names, spec, projectMarkdown, architecturePolicy) {
  const tree = packageCatalogTree(names);
  const candidates = cargoPlanCandidates(scopes, tree);
  if (!candidates.nested.size) return planCargoCrates(scopes, tree, candidates);
  const roots = declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, candidates.hints, scopes);
  // An explicit package catalog supplies names but no Cargo membership tables.
  // Keep the default crates/<name> layout of a declared root. Deeper packages
  // can be identified by their catalog entry or their own planned manifest.
  return planCargoCrates(
    scopes,
    tree,
    candidates,
    (dir, parent) => candidates.conventional.has(dir) && roots.has(parent) && directCratesMember(dir, parent),
  );
}

function packageCatalogTree(names) {
  const manifests = new Map();
  const catalogParents = new Set();
  for (const dir of names.keys()) {
    manifests.set(dir || '.', '');
    const slash = dir.lastIndexOf('/');
    if (slash >= 0) catalogParents.add(dir.slice(0, slash));
  }
  return { manifests, sources: [], entryKinds: new Map(), catalogParents };
}
function plannedCargoPackages(plan, actualNames) {
  const crates = new Map();
  for (const dir of plan.planned) {
    const name = actualNames.get(dir) ?? plan.inferred.get(dir);
    if (name && !plan.virtual.has(dir)) crates.set(dir, name);
  }
  return crates;
}
function policyContractNames(policy) {
  if (policy?.schemaVersion !== 2 || policy?.language !== 'rust') return null;
  const names = Array.isArray(policy.contractCrates) ? policy.contractCrates : [];
  return new Set(names.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()));
}
function selectContractRootsForWorkspace({ wsRoot, wsCrates, workspacesOf, explicitTokens, policyNames, actualNames }) {
  const roots = new Set();
  if (wsRoot === '' && policyNames) {
    for (const [root, name] of wsCrates.entries()) {
      if (policyNames.has(name)) roots.add(root);
    }
    for (const token of explicitTokens) {
      const dir = token === '.' ? '' : token;
      const pkgName = actualNames?.get(dir);
      if (pkgName && policyNames.has(pkgName) && workspacesOf(dir).includes(wsRoot)) roots.add(dir);
    }
    return roots;
  }
  for (const [root, name] of wsCrates.entries()) {
    if (explicitTokens.has(root) || explicitTokens.has(name) || CONTRACT_CRATE_NAME.test(name)) roots.add(root);
  }
  for (const token of explicitTokens) {
    if (token.includes('/') && workspacesOf(token).includes(wsRoot)) roots.add(token);
  }
  return roots;
}
function coversWorkspaceManifest(scopes, wsRoot) {
  const manifestPath = wsRoot ? `${wsRoot}/Cargo.toml` : 'Cargo.toml';
  for (const rawScope of scopes) {
    const scope = normalizeScopePath(rawScope);
    if (scope && (selectsCargoManifest(scope, manifestPath) || isExplicitContractScope(scope, wsRoot, manifestPath)))
      return true;
  }
  return false;
}
function hasRootPackageMember(spec, wsRoot, explicitRootPackages = new Set(), explicitTokens = new Set()) {
  if (explicitRootPackages.has(wsRoot)) return true;
  if (explicitTokens.has(wsRoot === '' ? '.' : wsRoot)) return true;
  const srcDir = wsRoot ? `${wsRoot}/src` : 'src';
  const libPath = `${srcDir}/lib.rs`;
  const mainPath = `${srcDir}/main.rs`;
  let hasManifest = false;
  let hasRustSrc = false;
  for (const task of spec.tasks) {
    if (coversWorkspaceManifest(task.writePaths ?? [], wsRoot)) hasManifest = true;
    for (const rawScope of task.writePaths ?? []) {
      const scope = normalizeScopePath(rawScope);
      if (!scope) continue;
      if (scope === libPath || scope === mainPath || (scope.startsWith(`${srcDir}/`) && /\.rs$/i.test(scope))) {
        hasRustSrc = true;
      }
    }
  }
  return hasManifest && hasRustSrc;
}
function waveZeroPolicyFindings({ waveZeroTasks, ancestors, architecturePolicy, requiredWorkspaces }) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return [];
  const policyTasks = waveZeroTasks.filter(task =>
    (task.writePaths ?? []).some(scope => isExplicitContractScope(scope, '', 'architecture.policy.json')),
  );
  if (!policyTasks.length) {
    return [
      finding(
        'architecture_policy_required',
        'Для Rust workspace с ≥ 3 крейтами Волна 0 (foundation) должна содержать задачу, ' +
          'создающую architecture.policy.json (в её writePaths), иначе гейты при architecture.enabled будут заблокированы',
      ),
    ];
  }
  const policyIds = new Set(policyTasks.map(task => task.id));
  const unordered = new Set(
    waveZeroTasks
      .filter(
        task =>
          !policyIds.has(task.id) &&
          !policyTasks.some(
            pt =>
              ancestors.get(task.id)?.has(pt.id) || (pt.epicId === task.epicId && ancestors.get(pt.id)?.has(task.id)),
          ),
      )
      .map(task => task.id),
  );
  // At the first epic gate carrying architecture.policy.json, the workspace manifest and
  // compilable contract crate must already exist (same task, same epic, or an ancestor task).
  for (const pt of policyTasks) {
    const ptAncestors = ancestors.get(pt.id) ?? new Set();
    const available = waveZeroTasks.filter(
      task => task.id === pt.id || task.epicId === pt.epicId || ptAncestors.has(task.id),
    );
    for (const { wsRoot, wsContracts } of requiredWorkspaces) {
      const hasManifest = available.some(task => coversWorkspaceManifest(task.writePaths ?? [], wsRoot));
      const hasContract = available.some(task =>
        [...wsContracts].some(contractRoot => taskCreatesCompilableContractCrate(task, contractRoot)),
      );
      if (!hasManifest || !hasContract) unordered.add(pt.id);
    }
  }
  if (!unordered.size) return [];
  return [
    finding(
      'architecture_policy_order',
      'Остальные задачи Волны 0 (foundation) должны зависеть от задачи, создающей architecture.policy.json, ' +
        'или совпадать с ней, а к гейту эпика с политикой уже должны существовать Cargo.toml и контрактный крейт',
      [...unordered].sort(compare),
    ),
  ];
}
/** Multi-crate Rust workspaces (>= 3 crates sharing a workspace root) must create a compilable
 * contract crate (`Cargo.toml` + `src/**`) and `architecture.policy.json` in Wave 0. */
export function rustContractCrateFindings(
  spec,
  projectMarkdown = '',
  architecturePolicy = null,
  ancestors = null,
  packageNames = null,
  cargoPlan = undefined,
) {
  const scopes = blueprintWriteScopes(spec);
  if (!isRustBlueprint(spec, projectMarkdown, architecturePolicy, scopes)) return [];
  const actualNames = normalizePackageNames(packageNames);
  const policyNames = policyContractNames(architecturePolicy);
  const plan = cargoPlan ?? planCatalogCrates(scopes, actualNames, spec, projectMarkdown, architecturePolicy);
  const allCrates = plannedCargoPackages(plan, actualNames);
  const explicitTokens = declaredContractTokens(spec, projectMarkdown);
  const explicitRootPackages = declaredRootPackages(spec, projectMarkdown);
  const workspaceRoots =
    plan.workspaceRoots ??
    [...declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, allCrates.keys(), scopes)].sort(
      (a, b) => b.length - a.length || compare(a, b),
    );
  const byWorkspace = new Map(workspaceRoots.map(wsRoot => [wsRoot, new Map()]));
  const workspacesOf = plan.workspaceOwners
    ? dir => plan.workspaceOwners.get(dir) ?? []
    : dir => {
        const owner = ownerWorkspaceOf(dir, workspaceRoots);
        return owner === undefined ? [] : [owner];
      };
  for (const [crateRoot, crateName] of allCrates.entries()) {
    for (const ownerWs of workspacesOf(crateRoot)) {
      if (crateRoot !== ownerWs) byWorkspace.get(ownerWs).set(crateRoot, crateName);
    }
  }
  for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
    if (
      !plan.virtual.has(wsRoot) &&
      workspacesOf(wsRoot).includes(wsRoot) &&
      ((plan.planned.has(wsRoot) && actualNames.has(wsRoot)) ||
        hasRootPackageMember(spec, wsRoot, explicitRootPackages, explicitTokens))
    ) {
      wsCrates.set(wsRoot, actualNames.get(wsRoot) ?? (wsRoot ? wsRoot.split('/').at(-1) : spec.id || 'root'));
    }
  }

  const allContractRoots = new Set();
  const contractsByWorkspace = new Map();
  if (workspaceRoots.length) {
    for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
      const roots = selectContractRootsForWorkspace({
        wsRoot,
        wsCrates,
        workspacesOf,
        explicitTokens,
        policyNames,
        actualNames,
      });
      contractsByWorkspace.set(wsRoot, roots);
      for (const root of roots) allContractRoots.add(root);
    }
  } else {
    for (const [root, name] of allCrates.entries()) {
      if (explicitTokens.has(root) || explicitTokens.has(name) || CONTRACT_CRATE_NAME.test(name))
        allContractRoots.add(root);
    }
    for (const token of explicitTokens) {
      if (token.includes('/')) allContractRoots.add(token);
    }
  }
  const protectedOwner = root => {
    const name = actualNames.get(root);
    if (!plan.workspaceOwners || !workspaceRoots.length) return allContractRoots.has(root) || policyNames?.has(name);
    return workspacesOf(root).some(local => {
      if (local === '' && policyNames) return policyNames.has(name);
      return (
        explicitTokens.has(root) ||
        explicitTokens.has(name) ||
        (contractsByWorkspace.get(local).has(root) &&
          (!policyNames || byWorkspace.get(local).size >= RUST_CONTRACT_CRATE_MIN))
      );
    });
  };
  const findings = broadContractScopeFindings(spec, allContractRoots, plan, protectedOwner);
  if (!workspaceRoots.length) return findings;

  const waveZeroEpics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const waveZeroTasks = spec.tasks.filter(task => waveZeroEpics.has(task.epicId));
  if (!waveZeroTasks.length) return findings;

  const requiredWorkspaces = [];
  let missingContract = false;
  for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
    if (wsCrates.size < RUST_CONTRACT_CRATE_MIN) continue;
    const wsContracts = contractsByWorkspace.get(wsRoot);
    requiredWorkspaces.push({ wsRoot, wsContracts });
    const satisfied = waveZeroTasks.some(task =>
      [...wsContracts].some(contractRoot => taskCreatesCompilableContractCrate(task, contractRoot)),
    );
    if (!satisfied) missingContract = true;
  }
  if (missingContract) {
    findings.push(
      finding(
        'contract_crate_required',
        'Для Rust workspace с ≥ 3 крейтами Волна 0 (foundation) должна содержать задачу, ' +
          'создающую компилируемый контрактный крейт (Cargo.toml и src/** в crates/<name>-contracts ' +
          'или явно объявленном контрактном крейте), защищённый через contractCrates в architecture.policy.json',
      ),
    );
  }
  if (requiredWorkspaces.length) {
    const resolvedAncestors = ancestors ?? taskAncestors(spec.tasks);
    findings.push(
      ...waveZeroPolicyFindings({
        waveZeroTasks,
        ancestors: resolvedAncestors,
        architecturePolicy,
        requiredWorkspaces,
      }),
    );
  }
  return findings;
}
// A manifest or crate directory (`crates/<name>/...`, including `crates/<name>/src/**`)
// makes a Rust project; a lone `*.rs` fixture or example outside a crate does not.
function isRustWriteScope(rawScope) {
  const scope = normalizeRelScope(rawScope);
  if (!scope) return false;
  if (/(?:^|[/{,])Cargo\.toml(?:[},]|$)/i.test(scope)) return true;
  if (conventionalCrateRoot(scope) || /(?:^|\/)crates\/[^/]+\/src(?:\/|$)/.test(scope)) return true;
  if (!scope.includes('{') && !scope.includes('@(')) return false;
  return (expandScopeAlternatives(scope) ?? []).some(
    branch => /(?:^|\/)Cargo\.toml$/i.test(branch) || conventionalCrateRoot(branch),
  );
}
const LETTER = String.raw`[\p{L}\p{N}_]`;
const RUST_WORD = new RegExp(`(?<!${LETTER})rust(?!${LETTER})`, 'giu');
const TECH = String.raw`[\p{L}\p{N}_+#-]+(?:\.[\p{L}\p{N}_+#-]+)*`;
const JOIN = String.raw`(?:\s*[/&|]\s*|\s+(?:and|or|nor|и|или)\s+)`;
const MODIFIERS = String.raw`(?:(?:пока|сейчас|ещ[её]|уже|больше|в настоящее время|в проекте|currently|presently|yet|still|now|at present|in this project)\s+)*`;
const NEGATED_BEFORE_RUST = new RegExp(
  String.raw`(?<!${LETTER})(?:no|not|without|без|не|нет)(?:\s+(?:use|using|использу\p{L}*|применя\p{L}*))?\s+(?:${TECH}${JOIN})*$`,
  'iu',
);
const NEGATED_AFTER_RUST = new RegExp(
  String.raw`^(?:${JOIN}${TECH})*(?:\s+v?\d+(?:\.\d+)*)?[\s(—–:-]*${MODIFIERS}(?:(?:is|are)\s+${MODIFIERS})?(?:not\s+(?:${MODIFIERS})used|no\s+longer\s+used|unused|disabled|absent|не\s+(?:использу(?:ется|ются)|применя(?:ется|ются))|отсутству(?:ет|ют)|нет)(?!${LETTER})`,
  'iu',
);
const RETIRED_BEFORE_RUST = new RegExp(
  String.raw`(?<!${LETTER})(?:отказ\p{L}*\s+от|dropped|abandoned|(?:moved|migrated)\s+away\s+from)\s+(?:${TECH}${JOIN})*$`,
  'iu',
);
const NOT_RETIRED = new RegExp(String.raw`(?<!${LETTER})(?:не|not|never)\s+$`, 'iu');
const USE_TARGET = /(?:^|\s)(?:in|on|within|by|for|(?:ни\s+)?(?:в|во|на|для))\s+(.+)$/iu;
// Russian passive predicates also take an agent in the instrumental case
// without a preposition, as in "не используется мобильными клиентами".
const INSTRUMENTAL_AGENT =
  /^(?:ни\s+)?(?:[а-яё-]+(?:ыми|ими|ым|им|ой|ей)\s+)*[а-яё-]+(?:ами|ями|ом|[её]м|ой|ей|ью|ою|ею)(?=\s|$)/iu;
const LEADING_MANNER = /^(?:(?:[а-яё-]{3,}(?:о|ски)|изредка)\s+)+/iu;
// Manner and time do not identify the consumer of Rust. Strip whole words
// so "directly by the browser" retains the same target as "by the browser".
const USAGE_MODIFIERS = new Set(
  (
    'напрямую непосредственно только лишь пока сейчас сегодня уже ещё еще больше ' +
    'directly only currently presently now yet still anymore'
  ).split(' '),
);
const TIME_PHRASE =
  /(?<!\S)(?:в\s+(?:настоящее\s+время|(?:данный|текущий)\s+момент)|at\s+(?:present|the\s+moment))(?!\S)/giu;
const QUANTIFIED_TARGET =
  /(?:^|\s)(?:ни\s+(?:(?:в|во|на|для)\s+)?одн\p{L}*(?:\s+из)?|(?:(?:in|on|within|by|for)\s+)?(?:any(?:\s+of)?|a\s+single)|нигде\s+(?:в|во|на)|(?:anywhere|nowhere)\s+(?:in|within|on))\s+(.+)$/iu;
// Generic project parts cover the whole project. A named subsystem or a
// restricted set such as "web components" leaves the declaration in force.
const GENERIC_PART_MODIFIER =
  /^(?:всех|этого|нашего|всего|данного|(?:существующ|имеющ|текущ|действующ)\p{L}*|the|this|our|whole|entire|current|existing|available)$/iu;
const PROJECT_PART_RU = /^(?:модул|компонент|част)\p{L}*(?:\s+(?:проекта|репозитория|приложения|системы))?$/iu;
const PROJECT_NOUN = '(?:project|repo(?:sitory)?|codebase|application|system)';
const PROJECT_PART_EN = new RegExp(
  `^(?:${PROJECT_NOUN}(?:['’]s)? )?(?:modules?|components?|parts?)(?: (?:in|of) ${PROJECT_NOUN})?$`,
  'iu',
);
const PROJECT_TARGET = [
  /^(?:(?:the|this|our|current|whole|entire)\s+)*(?:project|repo|repository|codebase)(?:\s+(?:yet|now|anymore))?$/iu,
  /^(?:(?:эт[ои]м|наш[ие]м|вс[её]м|данн[ыо]м|текущ[ие]м|самим|этого|нашего|всего)\s+)*(?:проект(?:[еа]|ом)?|репозитори(?:[ийяе]|ем)|код(?:е|ом)|кодовой баз(?:е|ой))(?:\s+(?:сейчас|пока))?$/iu,
  /^(?:now|the moment|настоящее время|(?:данный|текущий) момент|практике|целиком|вообще|совсем|нигде|никем|нами|целом)$/iu,
];

function declaresRustMention(before, after) {
  if (NEGATED_BEFORE_RUST.test(before)) return false;
  const retired = RETIRED_BEFORE_RUST.exec(before);
  if (retired && !NOT_RETIRED.test(before.slice(0, retired.index))) return false;
  const negation = NEGATED_AFTER_RUST.exec(after);
  if (!negation) return true;
  if (!negation[0].includes('(')) return false;
  // A component-specific qualification in parentheses leaves the enclosing
  // declaration in force. An unqualified or project-wide rejection cancels it.
  const qualifier = after
    .slice(negation[0].length)
    .split(/[),;.!?]/u, 1)[0]
    .replace(TIME_PHRASE, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => !USAGE_MODIFIERS.has(word))
    .join(' ');
  const quantified = QUANTIFIED_TARGET.exec(qualifier);
  if (quantified) {
    const noun = quantified[1]
      .split(' ')
      .filter(word => !GENERIC_PART_MODIFIER.test(word))
      .join(' ');
    return !(
      PROJECT_PART_RU.test(noun) ||
      PROJECT_PART_EN.test(noun) ||
      PROJECT_TARGET.some(re => re.test(quantified[1]))
    );
  }
  const agent = qualifier.replace(LEADING_MANNER, '');
  const target = USE_TARGET.exec(qualifier)?.[1] ?? (INSTRUMENTAL_AGENT.test(agent) && agent);
  return Boolean(target && !PROJECT_TARGET.some(pattern => pattern.test(target)));
}
/** Bind negation to the mention or its technology list, without crossing a sentence or unrelated prose. */
function declaresRustStack(projectMarkdown) {
  const lines = linesOutsideCodeFences(sectionLines(projectMarkdown, 'Стек').join('\n'));
  return lines.some(line => {
    const text = line.replace(/[`*]/g, '');
    for (const match of text.matchAll(RUST_WORD))
      if (declaresRustMention(text.slice(0, match.index), text.slice(match.index + match[0].length))) return true;
    return false;
  });
}
function isRustToolchainBlueprint(
  spec,
  projectMarkdown,
  architecturePolicy,
  { hasCommittedCargoManifest = false } = {},
) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return true;
  if (hasCommittedCargoManifest || declaresRustStack(projectMarkdown)) return true;
  return spec.tasks.some(task => (task.writePaths ?? []).some(isRustWriteScope));
}
/** Wave 0 for Rust blueprints must include `rust-toolchain.toml` (exact `channel = "1.x.y"`
 * with `clippy` and `rustfmt` components) in its writePaths unless a valid committed file already exists. */
export function rustToolchainFindings(
  spec,
  projectMarkdown = '',
  architecturePolicy = null,
  { hasRustToolchain = false, hasCommittedCargoManifest = false } = {},
) {
  if (hasRustToolchain) return [];
  const waveZeroEpics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const waveZeroTasks = spec.tasks.filter(task => waveZeroEpics.has(task.epicId));
  if (!waveZeroTasks.length) return [];
  if (!isRustToolchainBlueprint(spec, projectMarkdown, architecturePolicy, { hasCommittedCargoManifest })) return [];
  const coversToolchain = waveZeroTasks.some(task =>
    (task.writePaths ?? []).some(rawScope => {
      const scope = normalizeScopePath(rawScope);
      return (
        Boolean(scope) &&
        (scope === 'rust-toolchain.toml' ||
          scope.endsWith('/rust-toolchain.toml') ||
          isExplicitContractScope(scope, '', 'rust-toolchain.toml'))
      );
    }),
  );
  if (coversToolchain) return [];
  return [
    finding(
      'rust_toolchain_required',
      'Для Rust-проекта Волна 0 (foundation) должна содержать задачу с rust-toolchain.toml ' +
        '(точная версия channel = "1.x.y", компоненты clippy и rustfmt) в writePaths',
    ),
  ];
}
export async function readCargoPackagePlan(root, spec, projectMarkdown, revision, architecturePolicy) {
  const scopes = blueprintWriteScopes(spec);
  const names = new Map();
  if (!isRustBlueprint(spec, projectMarkdown, architecturePolicy, scopes)) return { names };
  const contractTokens = declaredContractTokens(spec, projectMarkdown);
  const hasNamedContract = [...contractTokens].some(token => token !== '.' && !token.includes('/'));
  const rootPackages = declaredRootPackages(spec, projectMarkdown);
  const declared = new Set([...Array.from(contractTokens, token => (token === '.' ? '' : token)), ...rootPackages]);
  const search = new Set(scopes);
  // A declared workspace may be beside all selected packages. Include its
  // manifest entry in the tree so a package.workspace pointer can find it.
  const declaredRoots = declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, [], []);
  for (const dir of [...declared, ...declaredRoots]) search.add(dir ? dir + '/Cargo.toml' : 'Cargo.toml');
  const tree = await readBlueprintCargoTree(root, search, revision);
  const reader = blueprintManifestReader(root, revision, tree);
  const plan = await readPlannedCargoCrates(reader, tree, scopes, spec, projectMarkdown, architecturePolicy);
  const policyNames = policyContractNames(architecturePolicy);
  const broadOwners = new Set();
  for (const owners of plan.broadOwners.values()) for (const dir of owners) broadOwners.add(dir);
  const selected = new Set([...plan.planned, ...declared]);
  if (policyNames?.size || hasNamedContract) for (const dir of broadOwners) selected.add(dir);
  const workspaceRoots = [...declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, plan.planned, scopes)];
  const workspaces = await readBlueprintWorkspaces(reader, workspaceRoots, selected, tree);
  const resolveMembership = [...workspaces.values()].some(rules => rules !== null);
  const planned = new Set([...plan.planned, ...rootPackages]);
  for (const wsRoot of workspaceRoots) {
    if (!planned.has(wsRoot) && hasRootPackageMember(spec, wsRoot, rootPackages, contractTokens)) planned.add(wsRoot);
  }
  const packageName = dir => {
    const name = cargoPackageTable(reader.docs.get(dir))?.name;
    return typeof name === 'string' ? name.trim() : '';
  };
  const needsPath = (dir, wsRoot, count) => {
    if (count >= RUST_CONTRACT_CRATE_MIN && planned.has(dir)) return true;
    if (!broadOwners.has(dir)) return false;
    const name = packageName(dir);
    if (wsRoot === '' && policyNames) return name ? policyNames.has(name) : policyNames.size > 0;
    if (contractTokens.has(dir || '.') || (name ? contractTokens.has(name) : hasNamedContract)) return true;
    return !policyNames && plan.planned.has(dir) && (!name || CONTRACT_CRATE_NAME.test(name));
  };
  // A known virtual manifest cannot contribute to any workspace's count.
  const upper = [...planned].filter(dir => !reader.docs.get(dir) || cargoPackageTable(reader.docs.get(dir))).length;
  const needed = [];
  const siblings = [];
  for (const dir of selected) {
    if (!tree.manifests.has(dir || '.')) continue;
    const needsOwner = wsRoot => !resolveMembership || needsPath(dir, wsRoot, upper);
    if (!workspaces.size || mayHaveWorkspaceOwner(dir, workspaces, needsOwner)) needed.push(dir);
    else siblings.push(dir);
  }
  await reader.read(needed);
  let workspaceOwners;
  if (resolveMembership) {
    const future = [...new Set([...selected, ...workspaceRoots])].filter(dir => !tree.manifests.has(dir || '.'));
    workspaceOwners = await blueprintWorkspaceOwners(reader, workspaces, {
      existing: needed.filter(dir => packageName(dir)),
      siblings,
      future,
      planned,
      needsPath,
      writesManifest: wsRoot => coversWorkspaceManifest(scopes, wsRoot),
    });
  }
  for (const dir of selected) {
    const doc = reader.docs.get(dir);
    if (!doc) continue;
    const name = packageName(dir);
    if (name) names.set(dir, name);
    else plan.virtual.add(dir);
  }
  return { names, plan: workspaceOwners ? { ...plan, workspaceRoots, workspaceOwners } : plan };
}

export async function readOptionalCargoPackageNames(root, specValue, projectMarkdown, revision = null) {
  return (await readCargoPackagePlan(root, specValue, projectMarkdown, revision, null)).names;
}
