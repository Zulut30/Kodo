/** Offline Cargo workspace resolver shared by Architecture Guardian and Rust tooling. */
import path from 'node:path';
import { CargoDirectoryNames, cargoMemberMatcher, hasCargoGlob, nativeManifestPath } from './cargo-member-paths.mjs';
export { compileCargoGlob } from './cargo-member-paths.mjs';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { braceBeforeExtglob, ownsPath, pathAndAncestors, scopeBraceGroup, scopeGlobSyntax } from './scope-paths.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function normalizeScopePath(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function literalScopePrefix(scope) {
  const literal = [];
  for (const segment of scope.split('/')) {
    if (scopeGlobSyntax.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

const MAX_SCOPE_BRACE_EXPANSIONS = 64;

export function scopeClassEnd(text, start) {
  let i = start + 1;
  if (text[i] === '!' || text[i] === '^') i++;
  if (text[i] === ']') i++;
  for (; i < text.length; i++) {
    if (text[i] === ']') return i;
    if (text.startsWith('[:', i)) {
      const end = text.indexOf(':]', i + 2);
      if (end !== -1) i = end + 1;
    }
  }
  return -1;
}

// A list of plain fragments cannot introduce an extglob delimiter. Inside a
// class even an empty fragment can change which ']' closes the class.
export function canDeferLiteralList(pattern, index, arms) {
  if (!arms.every(arm => /^[\p{L}\p{N}._-]*$/u.test(arm))) return false;
  for (let open = pattern.indexOf('['); open !== -1 && open < index;) {
    const close = scopeClassEnd(pattern, open);
    if (close < 0 || index < close) return false;
    open = pattern.indexOf('[', close + 1);
  }
  return true;
}

// Normalize the resolved directory prefix before combining it with more
// choices. Normalizing across an unopened group could cancel a different
// arm's parent (e.g. "{a/b,c}/../x").
function canonicalScopeBranch(pattern) {
  const separated = pattern.replace(/\/{2,}/g, '/');
  if (!/(?:^|\/)\.{1,2}(?:\/|$)/.test(separated)) return separated;
  // Leave a stray closing brace for the parser to reject.
  const meta = separated.search(/[*?[{}]|[+@!]\(/);
  const end = meta < 0 ? separated.length : separated.lastIndexOf('/', meta) + 1;
  if (!end) return separated;
  const prefix = path.posix.normalize(separated.slice(0, end));
  if (prefix === './') return separated.slice(end) || '.';
  return prefix + separated.slice(end);
}

/**
 * Expand brace alternation expressions `{a,b}` (including nested braces and
 * alternatives containing `/`) into full normalized scope strings.
 * Returns `null` for unbalanced braces or when bounded expansion is exhausted.
 * @param {string} rawScope
 * @param {number} [maxBranches]
 * @returns {string[] | null}
 */
export function expandScopeBraces(rawScope, maxBranches = MAX_SCOPE_BRACE_EXPANSIONS) {
  return expandScopeAlternatives(rawScope, maxBranches, false);
}

/** Enumerate braces and single-choice @(a|b) groups, keeping filenames and
 * their directories in the same branch. Other glob operators remain patterns. */
export function expandScopeAlternatives(rawScope, maxBranches = MAX_SCOPE_BRACE_EXPANSIONS, extglobs = true) {
  const scope = normalizeScopePath(rawScope);
  if (!scope) return [];
  const visited = new Set();
  const expanded = new Set();
  // Independent choices can all disappear behind a later "..". Bound the
  // intermediate work as well as the number of distinct emitted paths.
  const maxStates = (maxBranches + 1) * (1 + (scope.match(/[{},|]|@\(/g)?.length ?? 0));
  const expandOne = (pattern, offset = 0) => {
    const mixed = extglobs && braceBeforeExtglob(pattern, offset, canDeferLiteralList);
    if (mixed) return expandParts(pattern, mixed.start, mixed.end, mixed.arms);
    const group = extglobs ? /\[[^\]]*\]|@\(|[{}]/g : /[{}]/g;
    group.lastIndex = offset;
    let match;
    do {
      match = group.exec(pattern);
    } while (match?.[0].startsWith('['));
    if (!match) {
      const value = normalizeScopePath(pattern);
      if (value) expanded.add(value);
      return expanded.size <= maxBranches;
    }
    if (match[0] === '}') return false;
    const brace = match[0] === '{';
    const closers = [brace ? '}' : ')'];
    let close = -1;
    const parts = [];
    let start = group.lastIndex;
    for (let i = start; i < pattern.length; i++) {
      const ch = pattern[i];
      if (extglobs && ch === '[') {
        const end = pattern.indexOf(']', i + 1);
        if (end !== -1) i = end;
      } else if (ch === '{') closers.push('}');
      else if (extglobs && ch === '(') closers.push(')');
      else if (ch === closers.at(-1)) {
        closers.pop();
        if (!closers.length) {
          parts.push(pattern.slice(start, i));
          close = i;
          break;
        }
      } else if (ch === (brace ? ',' : '|') && closers.length === 1) {
        parts.push(pattern.slice(start, i));
        start = i + 1;
      }
    }
    if (close === -1) return false;
    // A range and a single braced word have no alternatives to split.
    // Node distinguishes e.g. {a..c} and the literal filename {codec}.
    if (!extglobs && brace && parts.length === 1) return expandOne(pattern, close + 1);
    return expandParts(pattern, match.index, close, parts);
  };
  function expandParts(pattern, start, close, parts) {
    const prefix = pattern.slice(0, start);
    const suffix = pattern.slice(close + 1);
    for (const part of parts) {
      const next = canonicalScopeBranch(prefix + part + suffix);
      if (visited.has(next)) continue;
      if (visited.size >= maxStates) return false;
      visited.add(next);
      if (!expandOne(next)) return false;
    }
    return true;
  }
  return expandOne(canonicalScopeBranch(scope)) ? [...expanded] : null;
}

// Enumerate alternatives written out in a blueprint, even in a long flat list.
// Products of independent groups still have a bound proportional to the input.
export function expandBlueprintScope(scope, minimum = MAX_SCOPE_BRACE_EXPANSIONS) {
  if (!scope.includes('{') && !scope.includes('@(')) return [scope];
  const alternatives = 1 + (scope.match(/[,|]/g)?.length ?? 0);
  return expandScopeAlternatives(scope, Math.max(minimum, alternatives));
}

export function blueprintScopeBranches(scope) {
  return expandBlueprintScope(scope) ?? [scope];
}

export function scopeMatchesPath(rawScope, rawFile) {
  const scope = normalizeScopePath(rawScope);
  const file = normalizeScopePath(rawFile);
  if (!scope || !file) return false;
  if (scope === '.') return true;
  return ownsPath([scope], file);
}

/**
 * Shared contract scope authorization predicate used by both the architecture gate
 * and the blueprint linter. A scope explicitly authorizes a contract crate only if
 * its leading literal path segments (before any glob metacharacter) completely name
 * the contract crate directory (or, for a root package, name the file/subtree literally).
 * @param {string} rawScope
 * @param {string} rawCrateRoot
 * @param {string | null} [rawChangedFile]
 */
export function isExplicitContractScope(rawScope, rawCrateRoot, rawChangedFile = null) {
  const scope = normalizeScopePath(rawScope);
  const crateRoot = normalizeScopePath(rawCrateRoot);
  if (!scope) return false;
  const literal = literalScopePrefix(scope);
  if (!literal || literal === '.') return false;
  if (crateRoot === '') {
    if (rawChangedFile === null) return true;
    const file = normalizeScopePath(rawChangedFile);
    return (literal === file || file.startsWith(`${literal}/`)) && scopeMatchesPath(scope, file);
  }
  const targetsCrate = literal === crateRoot || literal.startsWith(`${crateRoot}/`);
  if (!targetsCrate) return false;
  return rawChangedFile === null ? true : scopeMatchesPath(scope, rawChangedFile);
}

function segmentsIntersectSubtree(scopeSegs, rootSegs) {
  const visited = new Set();
  const walk = (si, ri) => {
    if (ri === rootSegs.length) return true;
    if (si === scopeSegs.length) return true;
    const key = `${si}:${ri}`;
    if (visited.has(key)) return false;
    visited.add(key);
    const seg = scopeSegs[si];
    if (seg === '**') return walk(si + 1, ri) || walk(si, ri + 1);
    if (path.posix.matchesGlob(rootSegs[ri], seg)) return walk(si + 1, ri + 1);
    return false;
  };
  return walk(0, 0);
}

function branchIntersectsSubtree(branch, crateRoot) {
  if (!branch) return false;
  if (branch === '.' || branch === '**') return true;
  if (crateRoot === '') return true;
  if (!scopeGlobSyntax.test(branch)) {
    return branch === crateRoot || crateRoot.startsWith(`${branch}/`) || branch.startsWith(`${crateRoot}/`);
  }
  return segmentsIntersectSubtree(branch.split('/'), crateRoot.split('/'));
}

// Contract lint also checks the legacy spelling {crates/name} for a whole path.
// Keep single-component literals and ranges intact. Task ownership uses the original scope.
export function unwrapContractPathGroups(scope) {
  let start = scope.indexOf('{');
  while (start !== -1) {
    const group = scopeBraceGroup(scope, start);
    if (group?.arms.length === 1 && group.arms[0].includes('/')) {
      scope = scope.slice(0, start) + group.arms[0] + scope.slice(group.end + 1);
      start = scope.indexOf('{', start);
    } else start = scope.indexOf('{', start + 1);
  }
  return scope;
}

/**
 * Returns true if `rawScope` (or any brace-expanded alternative of it) can intersect
 * any path inside `rawCrateRoot`'s subtree WITHOUT explicitly naming `rawCrateRoot`
 * via leading literal segments.
 * @param {string} rawScope
 * @param {string} rawCrateRoot
 */
export function isBroadContractScope(rawScope, rawCrateRoot) {
  if (isExplicitContractScope(rawScope, rawCrateRoot)) return false;
  const scope = normalizeScopePath(rawScope);
  const crateRoot = normalizeScopePath(rawCrateRoot);
  if (!scope) return false;
  if (scope === '.') return true;
  if (crateRoot === '') return literalScopePrefix(scope) === '';
  // Node matches ranges and extglobs inside a component. Keep them intact
  // before trying alternatives such as {apps/api,libs/core} that cross '/'.
  if (branchIntersectsSubtree(scope, crateRoot)) return true;
  if (!scope.includes('{')) return false;
  const branches = expandScopeBraces(unwrapContractPathGroups(scope));
  if (branches === null) {
    const literal = literalScopePrefix(scope);
    return !literal || crateRoot === literal || crateRoot.startsWith(`${literal}/`);
  }
  return branches.some(branch => branchIntersectsSubtree(branch, crateRoot));
}

export const isPlainObject = value =>
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
  if (isPlainObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  throw Object.assign(new Error('Cargo workspace: configuration'), { code: 'configuration' });
}

const hash = value => digest(JSON.stringify(canonical(value)));

export function decodeUtf8(raw) {
  if (typeof raw === 'string') return { text: raw, bytes: Buffer.from(raw, 'utf8') };
  if (!Buffer.isBuffer(raw)) return null;
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) return null;
  return { text, bytes: raw };
}

export function resolveRelativeDir(fromDir, rawPath) {
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

// Cargo resolves manifest path values with the host OS. Git tree keys and
// task scopes use slash-separated paths on every platform.
export function resolveManifestDir(fromDir, rawPath) {
  return resolveRelativeDir(fromDir, nativeManifestPath(rawPath));
}

export function normalizeWorkspacePath(raw, { allowGlob = false, preserveMemberDots = false } = {}) {
  if (typeof raw !== 'string') return null;
  const trimmed = nativeManifestPath(raw).trim();
  if (!trimmed || trimmed.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(trimmed) || trimmed.startsWith('/')) return null;
  if (!allowGlob && hasCargoGlob(trimmed)) return null;
  const parts = trimmed.split('/');
  if (parts.includes('..')) return null;
  const firstGlob = preserveMemberDots ? parts.findIndex(hasCargoGlob) : -1;
  return parts.filter((part, i) => part && (part !== '.' || (firstGlob >= 0 && i > firstGlob))).join('/');
}

export function parseWorkspaceDependencies(rawDeps) {
  const map = new Map();
  if (!isPlainObject(rawDeps)) return map;
  for (const key of Object.keys(rawDeps).sort(compare)) {
    const spec = rawDeps[key];
    if (typeof spec === 'string') {
      map.set(key, { key, packageName: key, path: null, valid: true });
    } else if (isPlainObject(spec)) {
      const packageName = typeof spec.package === 'string' && spec.package.trim() ? spec.package.trim() : key;
      const depPath = spec.path === undefined ? null : typeof spec.path === 'string' ? spec.path : undefined;
      map.set(key, { key, packageName, path: depPath ?? null, valid: depPath !== undefined });
    } else {
      map.set(key, { key, packageName: key, path: null, valid: false });
    }
  }
  return map;
}

// Cargo accepts the historical [project] table before the 2024 edition.
// If both tables are present the [package] table takes precedence.
export function cargoPackageTable(doc) {
  const pkg = doc?.package === undefined ? doc?.project : doc.package;
  return isPlainObject(pkg) ? pkg : null;
}

export function resolvePackageEdition(doc, workspacePackage = null) {
  const raw = cargoPackageTable(doc)?.edition;
  if (raw === undefined) return { edition: '2015', error: null };
  const inherited = isPlainObject(raw) && raw.workspace === true;
  const edition = inherited ? workspacePackage?.edition : raw;
  if (typeof edition !== 'string' || !/^\d{4}$/.test(edition.trim()))
    return { edition: null, error: inherited ? 'unresolved-workspace-edition' : 'invalid-package-edition' };
  if (doc.project !== undefined && Number(edition) >= 2024) return { edition: null, error: 'invalid-crate-manifest' };
  return { edition: edition.trim(), error: null };
}

export function collectManifestDependencies(doc, { edition = '2015', onUnsupported = null } = {}) {
  const rows = [];
  const forbidUnderscore = edition !== null && Number(edition) >= 2024;
  const addSection = (table, kind) => {
    if (!isPlainObject(table)) return;
    for (const key of Object.keys(table).sort(compare)) rows.push({ key, spec: table[key], kind });
  };
  const addAliasedSection = (area, hyphenKey, underscoreKey, kind) => {
    if (!isPlainObject(area)) return;
    const hasHyphen = area[hyphenKey] !== undefined;
    const hasUnderscore = area[underscoreKey] !== undefined;
    if (forbidUnderscore && hasUnderscore) onUnsupported?.('unsupported-underscore-dependencies');
    if (hasHyphen) addSection(area[hyphenKey], kind);
    else if (!forbidUnderscore && hasUnderscore) addSection(area[underscoreKey], kind);
  };
  addSection(doc.dependencies, 'dependency');
  addAliasedSection(doc, 'dev-dependencies', 'dev_dependencies', 'dev-dependency');
  addAliasedSection(doc, 'build-dependencies', 'build_dependencies', 'build-dependency');
  if (isPlainObject(doc.target)) {
    for (const targetKey of Object.keys(doc.target).sort(compare)) {
      const section = doc.target[targetKey];
      if (!isPlainObject(section)) continue;
      addSection(section.dependencies, 'dependency');
      addAliasedSection(section, 'dev-dependencies', 'dev_dependencies', 'dev-dependency');
      addAliasedSection(section, 'build-dependencies', 'build_dependencies', 'build-dependency');
    }
  }
  return rows;
}

const joinRel = (base, rel) => (!base ? rel : !rel ? base : `${base}/${rel}`);

function relativeToRoot(rootDir, dir) {
  if (!rootDir) return dir;
  if (dir === rootDir) return '';
  if (dir.startsWith(`${rootDir}/`)) return dir.slice(rootDir.length + 1);
  return null;
}

// Resolve the literal prefix of a member glob inside the caller's tree.
// No parent component is passed to a tree walk or Git pathspec.
export function workspaceMemberPattern(root, raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  raw = nativeManifestPath(raw);
  const parts = raw.trim().split('/');
  const end = parts.lastIndexOf('..') + 1;
  const base = end ? resolveRelativeDir(root, parts.slice(0, end).join('/')) : root;
  const suffix = end ? parts.slice(end).filter(Boolean).join('/') || '.' : raw;
  const pattern = normalizeWorkspacePath(suffix, { allowGlob: true, preserveMemberDots: true });
  return base === null || pattern === null ? null : joinRel(base, pattern);
}

function toManifestMap(manifests) {
  if (manifests instanceof Map) return manifests;
  if (isPlainObject(manifests)) return new Map(Object.entries(manifests));
  return new Map();
}

function parseManifestEntry(raw) {
  if (raw === undefined) return { error: 'missing' };
  const withPackage = doc => {
    const pkg = cargoPackageTable(doc);
    return pkg && doc.package === undefined ? { ...doc, package: pkg } : doc;
  };
  if (isPlainObject(raw)) {
    let manifestHash;
    try {
      manifestHash = hash(raw);
    } catch {
      manifestHash = digest(JSON.stringify(raw));
    }
    return { doc: withPackage(raw), hash: manifestHash };
  }
  const decoded = decodeUtf8(raw);
  if (!decoded) return { error: 'parse-error' };
  try {
    return { doc: withPackage(parseToml(decoded.text)), hash: digest(decoded.bytes) };
  } catch {
    return { error: 'parse-error', hash: digest(decoded.bytes) };
  }
}

function findCandidateRoots(startDir, manifestDirs, parsedCache) {
  let workspaceCandidate = null;
  let packageCandidate = null;
  for (const dir of pathAndAncestors(startDir)) {
    if (!manifestDirs.has(dir)) continue;
    const entry = parsedCache(dir);
    if (entry.error) {
      if (dir === startDir || dir === '') return { workspaceCandidate: { rootDir: dir, entry }, packageCandidate };
      continue;
    }
    if (isPlainObject(entry.doc.workspace) && workspaceCandidate === null) {
      workspaceCandidate = { rootDir: dir, entry };
    }
    if (isPlainObject(entry.doc.package) && packageCandidate === null) {
      packageCandidate = { rootDir: dir, entry };
      if (entry.doc.package.workspace !== undefined) {
        const pkgManifest = dir ? `${dir}/Cargo.toml` : 'Cargo.toml';
        if (isPlainObject(entry.doc.workspace) || typeof entry.doc.package.workspace !== 'string') {
          return {
            workspaceCandidate: null,
            packageCandidate,
            explicitWorkspace: false,
            explicitError: { scope: 'manifest', file: pkgManifest, reason: 'invalid-workspace-config' },
          };
        }
        if (workspaceCandidate === null) {
          const explicitDir = resolveManifestDir(dir, entry.doc.package.workspace);
          if (explicitDir === null) {
            return {
              workspaceCandidate: null,
              packageCandidate,
              explicitWorkspace: false,
              explicitError: { scope: 'manifest', file: pkgManifest, reason: 'unsafe-path' },
            };
          }
          const wsEntry = manifestDirs.has(explicitDir) ? parsedCache(explicitDir) : { error: 'missing' };
          if (!wsEntry.error && !isPlainObject(wsEntry.doc.workspace)) {
            const wsManifest = explicitDir ? `${explicitDir}/Cargo.toml` : 'Cargo.toml';
            return {
              workspaceCandidate: null,
              packageCandidate,
              explicitWorkspace: false,
              explicitError: { scope: 'workspace', file: wsManifest, reason: 'missing-cargo-workspace' },
            };
          }
          return {
            workspaceCandidate: { rootDir: explicitDir, entry: wsEntry },
            packageCandidate,
            explicitWorkspace: true,
          };
        }
      }
    }
    if (workspaceCandidate !== null) break;
  }
  return { workspaceCandidate, packageCandidate, explicitWorkspace: false };
}

function isNestedWorkspaceRoot(rootDir, candidateDir, manifestDirs, parsedCache) {
  if (candidateDir === rootDir || !manifestDirs.has(candidateDir)) return false;
  const parsed = parsedCache(candidateDir);
  return !parsed.error && isPlainObject(parsed.doc.workspace);
}

function workspacePaths(items, parse, onInvalid) {
  const paths = [];
  if (items === undefined) return paths;
  if (!Array.isArray(items)) {
    onInvalid?.('invalid-workspace-config');
    return paths;
  }
  for (const item of items) {
    const normalized = parse(item);
    if (normalized === null) onInvalid?.('unsafe-path');
    else paths.push(normalized);
  }
  return paths;
}

// Cargo compares both lists as literal path prefixes for exclusion. A member
// glob or path dependency must still independently select a nested package.
export function workspaceExclusionMatcher(root, workspace, onInvalid = undefined) {
  // For the prefix comparison Cargo keeps the original spelling of '..'.
  // Such an entry cannot be a prefix of a normalized manifest path.
  const prefix = raw => {
    const rel = normalizeWorkspacePath(raw, { allowGlob: true });
    return rel === null ? null : joinRel(root, rel);
  };
  const excluded = new Set(workspacePaths(workspace?.exclude, prefix, onInvalid));
  if (!excluded.size) return () => false;
  const declared = new Set(workspacePaths(workspace?.members, prefix, undefined));
  return dir => {
    const ancestors = [...pathAndAncestors(joinRel(dir, 'Cargo.toml'))];
    return ancestors.some(p => excluded.has(p)) && !ancestors.some(p => declared.has(p));
  };
}

function collectDeclaredMembers({
  patterns,
  rootDir,
  rootManifest,
  names,
  manifestDirs,
  snapshotDirs,
  snapshotFiles,
  parsedCache,
  isExcluded,
  unknown,
}) {
  const selected = new Map();
  const select = (dir, spelling) => {
    if (selected.has(dir) && selected.get(dir) !== spelling) {
      unknown('workspace', joinRel(dir, 'Cargo.toml'), 'duplicate-crate-name');
      return false;
    }
    selected.set(dir, spelling);
    return true;
  };
  for (const pattern of patterns) {
    const spelling = joinRel(rootDir, pattern);
    if (!hasCargoGlob(pattern)) {
      const memberDir = names.resolve(spelling);
      // The root package, if present, is added once after member selection.
      if (memberDir === rootDir || isExcluded(spelling)) continue;
      if (!manifestDirs.has(memberDir)) {
        unknown('workspace', rootManifest, 'missing-workspace-member');
        continue;
      }
      if (isNestedWorkspaceRoot(rootDir, memberDir, manifestDirs, parsedCache)) {
        unknown('workspace', `${memberDir}/Cargo.toml`, 'nested-workspace-root');
        continue;
      }
      select(memberDir, spelling);
      continue;
    }
    const match = cargoMemberMatcher(spelling, names);
    if (!match) {
      unknown('workspace', rootManifest, 'unsupported-member-glob');
      continue;
    }
    // A dot entry can select the root itself, whose package is handled below.
    let matched = 'parentSearchRoot' in match && match(rootDir) !== null;
    for (const dir of snapshotDirs) {
      if (dir === rootDir || relativeToRoot(rootDir, dir) === null) continue;
      for (const chosen of match.spellings(dir)) {
        matched = true;
        if (isExcluded(chosen)) continue;
        if (!manifestDirs.has(dir)) {
          unknown('workspace', joinRel(dir, 'Cargo.toml'), 'member-without-manifest');
          break;
        }
        if (isNestedWorkspaceRoot(rootDir, dir, manifestDirs, parsedCache)) {
          unknown('workspace', `${dir}/Cargo.toml`, 'nested-workspace-root');
          break;
        }
        if (!select(dir, chosen)) break;
      }
    }
    if (
      !matched &&
      (match.directoriesOnly ||
        ![...snapshotFiles].some(file => relativeToRoot(rootDir, file) !== null && match(file, false) !== null))
    )
      unknown('workspace', rootManifest, 'member-glob-no-match');
  }
  return selected;
}

// Inherited paths start at the workspace manifest. The blueprint can admit
// an explicit sibling member by using the enclosing project as its boundary.
export function resolveDepTargetDir(dep, dir, rootDir, workspaceDependencies, boundary = rootDir) {
  const spec = dep.spec;
  if (!isPlainObject(spec)) return null;
  let from = dir;
  let depPath = spec.path;
  if (spec.workspace === true) {
    const inherited = workspaceDependencies.get(dep.key);
    if (!inherited?.valid) return null;
    from = rootDir;
    depPath = inherited.path;
  }
  const base = relativeToRoot(boundary, from);
  const resolved = base === null ? null : resolveManifestDir(base, depPath);
  return resolved === null ? null : joinRel(boundary, resolved);
}

function expandPathMembers({
  selected,
  names,
  rootDir,
  workspaceDependencies,
  workspacePackage,
  manifestDirs,
  parsedCache,
  isExcluded,
  unknown,
}) {
  const queue = [...selected.keys()].sort(compare);
  const visited = new Set(queue);
  while (queue.length) {
    const dir = queue.shift();
    const parsed = parsedCache(dir);
    if (parsed.error) continue;
    const { edition } = resolvePackageEdition(parsed.doc, workspacePackage);
    for (const dep of collectManifestDependencies(parsed.doc, { edition: edition ?? '2015' })) {
      const spelling = resolveDepTargetDir(dep, selected.get(dir), rootDir, workspaceDependencies);
      if (spelling === null || isExcluded(spelling)) continue;
      const targetDir = names.resolve(spelling);
      if (!manifestDirs.has(targetDir)) continue;
      if (isNestedWorkspaceRoot(rootDir, targetDir, manifestDirs, parsedCache)) {
        unknown('workspace', `${targetDir}/Cargo.toml`, 'nested-workspace-root');
        continue;
      }
      if (!visited.has(targetDir)) {
        visited.add(targetDir);
        selected.set(targetDir, spelling);
        queue.push(targetDir);
      } else if (selected.get(targetDir) !== spelling) {
        unknown('workspace', joinRel(targetDir, 'Cargo.toml'), 'duplicate-crate-name');
      }
    }
  }
}

function loadMemberPackages(selected, rootDir, parsedCache, workspacePackage, unknown) {
  const members = [];
  const seenNames = new Set();
  for (const dir of [...selected].sort(compare)) {
    const manifest = dir ? `${dir}/Cargo.toml` : 'Cargo.toml';
    const parsed = parsedCache(dir);
    if (parsed.error) {
      unknown('manifest', manifest, 'parse-error', 0);
      continue;
    }
    if (parsed.doc.package?.workspace !== undefined) {
      if (isPlainObject(parsed.doc.workspace) || typeof parsed.doc.package.workspace !== 'string') {
        unknown('manifest', manifest, 'invalid-workspace-config');
      } else {
        const declaredWs = resolveManifestDir(dir, parsed.doc.package.workspace);
        if (declaredWs === null) unknown('manifest', manifest, 'unsafe-path');
        else if (declaredWs !== rootDir) unknown('workspace', manifest, 'wrong-workspace-root');
      }
    }
    const name = typeof parsed.doc.package?.name === 'string' ? parsed.doc.package.name.trim() : '';
    if (!name) {
      unknown('manifest', manifest, 'invalid-crate-manifest');
      continue;
    }
    if (seenNames.has(name)) {
      unknown('workspace', manifest, 'duplicate-crate-name');
      continue;
    }
    seenNames.add(name);
    const { edition, error: editionError } = resolvePackageEdition(parsed.doc, workspacePackage);
    if (editionError) unknown('manifest', manifest, editionError);
    collectManifestDependencies(parsed.doc, {
      edition: edition ?? '2015',
      onUnsupported: reason => unknown('manifest', manifest, reason),
    });
    members.push({ name, root: dir, manifest, manifestHash: parsed.hash, edition: edition ?? '2015', doc: parsed.doc });
  }
  return members.sort((a, b) => compare(a.manifest, b.manifest));
}

function emptyWorkspaceResult(rootDir, rootManifest, rootManifestHash, rootDoc, unsupported) {
  return {
    root: rootDir,
    rootManifest,
    rootManifestHash,
    hasWorkspace: false,
    rootDoc,
    workspaceDependencies: new Map(),
    members: [],
    unsupported: [...unsupported.values()],
  };
}

function collectSnapshotEntries(rawMap, files) {
  const snapshotFiles = new Set();
  const snapshotDirs = new Set();
  const addFile = raw => {
    const cleaned = normalizeScopePath(typeof raw === 'string' ? raw : raw?.path);
    if (!cleaned) return;
    snapshotFiles.add(cleaned);
    const parent = path.posix.dirname(cleaned);
    for (const dir of pathAndAncestors(parent === '.' ? '' : parent)) snapshotDirs.add(dir);
  };
  for (const file of rawMap.keys()) addFile(file);
  if (Array.isArray(files)) {
    for (const entry of files) addFile(entry);
  }
  return { snapshotDirs, snapshotFiles };
}

function resolveWorkspaceAtRoot({ rootDir, rootEntry, names, manifestDirs, snapshotDirs, snapshotFiles, parsedCache }) {
  const unsupported = new Map();
  const unknown = (scope, file, reason, offset = null) => {
    const id = hash([scope, file, reason, offset]);
    unsupported.set(id, { id, scope, file, reason, offset });
  };
  const rootManifest = rootDir ? `${rootDir}/Cargo.toml` : 'Cargo.toml';

  if (rootEntry.error === 'missing') {
    unknown('workspace', rootManifest, 'missing-cargo-workspace');
    return {
      result: emptyWorkspaceResult(rootDir, rootManifest, null, null, unsupported),
      selected: new Set(),
      isExcluded: () => false,
    };
  }
  if (rootEntry.error) {
    unknown('manifest', rootManifest, 'parse-error', 0);
    return {
      result: emptyWorkspaceResult(rootDir, rootManifest, rootEntry.hash ?? null, null, unsupported),
      selected: new Set(),
      isExcluded: () => false,
    };
  }

  const rootDoc = rootEntry.doc;
  const rootManifestHash = rootEntry.hash;
  const hasWorkspace = isPlainObject(rootDoc.workspace);
  const hasRootPackage = isPlainObject(rootDoc.package);

  if (!hasWorkspace && !hasRootPackage) {
    unknown('workspace', rootManifest, 'missing-cargo-workspace');
    return {
      result: emptyWorkspaceResult(rootDir, rootManifest, rootManifestHash, rootDoc, unsupported),
      selected: new Set(),
      isExcluded: () => false,
    };
  }

  const workspace = hasWorkspace ? rootDoc.workspace : {};
  const workspaceDependencies = parseWorkspaceDependencies(workspace.dependencies);
  const workspacePackage = isPlainObject(workspace.package) ? workspace.package : null;
  const invalid = reason => unknown('workspace', rootManifest, reason);
  const patterns = workspacePaths(workspace.members, raw => workspaceMemberPattern('', raw), invalid);
  const isExcluded = workspaceExclusionMatcher(rootDir, workspace, invalid);

  const selected = hasWorkspace
    ? collectDeclaredMembers({
        patterns,
        rootDir,
        rootManifest,
        names,
        manifestDirs,
        snapshotDirs,
        snapshotFiles,
        parsedCache,
        isExcluded,
        unknown,
      })
    : new Map();
  if (hasRootPackage) selected.set(rootDir, rootDir);

  if (hasWorkspace) {
    expandPathMembers({
      selected,
      names,
      rootDir,
      workspaceDependencies,
      workspacePackage,
      manifestDirs,
      parsedCache,
      isExcluded,
      unknown,
    });
  }

  const members = loadMemberPackages(selected.keys(), rootDir, parsedCache, workspacePackage, unknown);
  return {
    selected,
    isExcluded,
    result: {
      root: rootDir,
      rootManifest,
      rootManifestHash,
      hasWorkspace,
      rootDoc,
      workspaceDependencies,
      members,
      unsupported: [...unsupported.values()].sort(
        (a, b) => compare(a.file ?? '', b.file ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.id, b.id),
      ),
    },
  };
}

function createWorkspaceIndex({ manifests, files = undefined, probeAlias = undefined }) {
  const rawMap = toManifestMap(manifests);
  const { snapshotDirs, snapshotFiles } = collectSnapshotEntries(rawMap, files);
  const manifestDirs = new Map();
  for (const manifestPath of rawMap.keys()) {
    const normalized = manifestPath.replaceAll('\\', '/');
    if (normalized === 'Cargo.toml' || normalized.endsWith('/Cargo.toml')) {
      const dir = path.posix.dirname(normalized);
      manifestDirs.set(dir === '.' ? '' : dir, manifestPath);
    }
  }
  const cache = new Map();
  const parsedCache = dir => {
    if (cache.has(dir)) return cache.get(dir);
    const key = manifestDirs.get(dir);
    const parsed = parseManifestEntry(key !== undefined ? rawMap.get(key) : undefined);
    cache.set(dir, parsed);
    return parsed;
  };
  return {
    rawMap,
    snapshotDirs,
    snapshotFiles,
    manifestDirs,
    parsedCache,
    names: new CargoDirectoryNames(snapshotDirs, probeAlias),
  };
}

function resolveStartDir(index, startDir, resolvedCache = new Map()) {
  const { snapshotDirs, snapshotFiles, manifestDirs, parsedCache } = index;
  const cleanStart = normalizeWorkspacePath(startDir === '' ? '.' : startDir) ?? '';
  const { workspaceCandidate, packageCandidate, explicitError, explicitWorkspace } = findCandidateRoots(
    cleanStart,
    manifestDirs,
    parsedCache,
  );
  if (explicitError) {
    const unsupported = new Map();
    const id = hash([explicitError.scope, explicitError.file, explicitError.reason, null]);
    unsupported.set(id, { id, ...explicitError, offset: null });
    const rootManifest = cleanStart ? `${cleanStart}/Cargo.toml` : 'Cargo.toml';
    return emptyWorkspaceResult(cleanStart, rootManifest, null, null, unsupported);
  }
  const resolveFrom = candidate => {
    if (resolvedCache.has(candidate.rootDir)) return resolvedCache.get(candidate.rootDir);
    const resolved = resolveWorkspaceAtRoot({
      rootDir: candidate.rootDir,
      rootEntry: candidate.entry,
      names: index.names,
      manifestDirs,
      snapshotDirs,
      snapshotFiles,
      parsedCache,
    });
    resolved.memberRoots = new Set(resolved.result.members.map(item => item.root));
    resolvedCache.set(candidate.rootDir, resolved);
    return resolved;
  };

  if (!workspaceCandidate) {
    const fallback = packageCandidate ?? {
      rootDir: cleanStart,
      entry: manifestDirs.has(cleanStart) ? parsedCache(cleanStart) : { error: 'missing' },
    };
    return resolveFrom(fallback).result;
  }

  const wsResolved = resolveFrom(workspaceCandidate);
  if (
    !packageCandidate ||
    packageCandidate.rootDir === workspaceCandidate.rootDir ||
    wsResolved.selected.has(packageCandidate.rootDir)
  ) {
    return wsResolved.result;
  }
  if (wsResolved.isExcluded(packageCandidate.rootDir) && !explicitWorkspace) {
    return resolveFrom(packageCandidate).result;
  }
  const pkgManifest = packageCandidate.rootDir ? `${packageCandidate.rootDir}/Cargo.toml` : 'Cargo.toml';
  const unsupported = new Map(wsResolved.result.unsupported.map(item => [item.id, item]));
  const id = hash(['workspace', pkgManifest, 'unlisted-workspace-member', null]);
  unsupported.set(id, { id, scope: 'workspace', file: pkgManifest, reason: 'unlisted-workspace-member', offset: null });
  return {
    ...wsResolved.result,
    unsupported: [...unsupported.values()].sort(
      (a, b) => compare(a.file ?? '', b.file ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.id, b.id),
    ),
  };
}

/**
 * Resolve a Cargo workspace offline using Cargo's member/exclude/path-dependency rules.
 * @param {{ manifests: Map<string, Buffer | string | Record<string, any>> | Record<string, Buffer | string | Record<string, any>>, files?: Array<string | { path: string }>, startDir?: string, probeAlias?: (original: string, spelling: string) => boolean }} input
 */
export function resolveCargoWorkspace(input) {
  return resolveStartDir(createWorkspaceIndex(input), input.startDir ?? '');
}

/**
 * Map every package directory belonging to a valid Cargo workspace to its workspace root.
 * Indexes manifests and snapshot files once and caches resolution per workspace root.
 * @param {{ manifests: Map<string, Buffer | string | Record<string, any>> | Record<string, Buffer | string | Record<string, any>>, files?: Array<string | { path: string }>, probeAlias?: (original: string, spelling: string) => boolean }} input
 * @returns {Map<string, string>}
 */
export function resolveCargoWorkspaceRoots(input) {
  const index = createWorkspaceIndex(input);
  const resolvedCache = new Map();
  const roots = new Map();
  for (const member of index.manifestDirs.keys()) {
    const entry = index.parsedCache(member);
    if (entry.error || !isPlainObject(entry.doc?.package)) continue;
    const resolved = resolveStartDir(index, member, resolvedCache);
    if (resolved.unsupported.length || !resolved.hasWorkspace) continue;
    const cached = resolvedCache.get(resolved.root);
    const isMember = cached ? cached.memberRoots.has(member) : resolved.members.some(item => item.root === member);
    if (isMember) roots.set(member, resolved.root);
  }
  return roots;
}
