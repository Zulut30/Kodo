/** Offline Cargo workspace resolver shared by Architecture Guardian and Rust tooling. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SCOPE_GLOB_META = /[*?[{]/;

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
    if (SCOPE_GLOB_META.test(segment)) break;
    literal.push(segment);
  }
  return literal.join('/');
}

export function scopeMatchesPath(rawScope, rawFile) {
  const scope = normalizeScopePath(rawScope);
  const file = normalizeScopePath(rawFile);
  if (!scope || !file) return false;
  if (scope === '.' || scope === '**') return true;
  if (!SCOPE_GLOB_META.test(scope)) return file === scope || file.startsWith(`${scope}/`);
  if (scope.endsWith('/**')) {
    const base = scope.slice(0, -3);
    if (base && !SCOPE_GLOB_META.test(base) && (file === base || file.startsWith(`${base}/`))) return true;
  }
  return path.posix.matchesGlob(file, scope);
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

/**
 * Returns true if `rawScope` can intersect any path inside `rawCrateRoot`'s subtree
 * WITHOUT explicitly naming `rawCrateRoot` via literal segments.
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
  if (!SCOPE_GLOB_META.test(scope)) return crateRoot === scope || crateRoot.startsWith(`${scope}/`);
  return segmentsIntersectSubtree(scope.split('/'), crateRoot.split('/'));
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

const hasGlobMeta = pattern => /[*?[]/.test(pattern);

function normalizeWorkspacePath(raw, { allowGlob = false } = {}) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(trimmed) || trimmed.startsWith('/')) return null;
  if (!allowGlob && hasGlobMeta(trimmed)) return null;
  const cleaned = trimmed.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!cleaned || cleaned === '.') return '';
  const parts = cleaned.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return cleaned;
}

function escapeRegexChar(ch) {
  return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function compileGlobSegment(segment) {
  let regex = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if (ch === '[') {
      let j = i + 1;
      if (j >= segment.length) return null;
      let cls = '[';
      if (segment[j] === '!') {
        cls += '^';
        j++;
      } else if (segment[j] === '^') {
        cls += '\\^';
        j++;
      }
      if (j < segment.length && segment[j] === ']') {
        cls += '\\]';
        j++;
      }
      let closed = false;
      while (j < segment.length) {
        const inner = segment[j];
        if (inner === ']') {
          closed = true;
          break;
        }
        if (inner === '\\') cls += '\\\\';
        else if (inner === '[') cls += '\\[';
        else cls += inner;
        j++;
      }
      if (!closed) return null;
      cls += ']';
      regex += cls;
      i = j;
    } else if (ch === ']') {
      return null;
    } else {
      regex += escapeRegexChar(ch);
    }
  }
  return regex;
}

/**
 * Compile a Cargo member glob pattern following the Rust `glob` crate semantics:
 * `*` matches 0+ chars in a segment, `?` matches 1 char, `[...]` / `[!...]` character class,
 * and `**` matches 0+ path segments.
 * Returns `null` if the pattern is syntactically invalid.
 * @param {string} pattern
 * @returns {RegExp | null}
 */
export function compileCargoGlob(pattern) {
  if (pattern === '') return /^$/;
  const parts = pattern.split('/');
  let expr = '^';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '**') {
      if (i === parts.length - 1) {
        expr += i === 0 ? '.*' : '(?:/.*)?';
      } else {
        expr += i === 0 ? '(?:.+/)?' : '(?:/.+)?';
      }
      continue;
    }
    if (part.includes('**')) return null;
    const compiled = compileGlobSegment(part);
    if (compiled === null) return null;
    if (i > 0) {
      expr += parts[i - 1] === '**' ? (i - 1 === 0 ? '' : '/') : '/';
    }
    expr += compiled;
  }
  expr += '$';
  try {
    return new RegExp(expr);
  } catch {
    return null;
  }
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

export function resolvePackageEdition(doc, workspacePackage = null) {
  const raw = doc?.package?.edition;
  if (raw === undefined) return { edition: '2015', error: null };
  if (typeof raw === 'string' && /^\d{4}$/.test(raw.trim())) return { edition: raw.trim(), error: null };
  if (isPlainObject(raw) && raw.workspace === true) {
    const inherited = workspacePackage?.edition;
    if (typeof inherited === 'string' && /^\d{4}$/.test(inherited.trim()))
      return { edition: inherited.trim(), error: null };
    return { edition: null, error: 'unresolved-workspace-edition' };
  }
  return { edition: null, error: 'invalid-package-edition' };
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

function ancestorsOf(dir) {
  const result = [];
  let current = dir;
  while (true) {
    result.push(current);
    if (!current) break;
    const slash = current.lastIndexOf('/');
    current = slash === -1 ? '' : current.slice(0, slash);
  }
  return result;
}

function toManifestMap(manifests) {
  if (manifests instanceof Map) return manifests;
  if (isPlainObject(manifests)) return new Map(Object.entries(manifests));
  return new Map();
}

function parseManifestEntry(raw) {
  if (raw === undefined) return { error: 'missing' };
  const decoded = decodeUtf8(raw);
  if (!decoded) return { error: 'parse-error' };
  try {
    return { doc: parseToml(decoded.text), hash: digest(decoded.bytes) };
  } catch {
    return { error: 'parse-error', hash: digest(decoded.bytes) };
  }
}

function findCandidateRoots(startDir, manifestDirs, parsedCache) {
  const chain = ancestorsOf(startDir);
  let workspaceCandidate = null;
  let packageCandidate = null;
  for (const dir of chain) {
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
      if (workspaceCandidate === null && entry.doc.package.workspace !== undefined) {
        const pkgManifest = dir ? `${dir}/Cargo.toml` : 'Cargo.toml';
        if (typeof entry.doc.package.workspace !== 'string') {
          return {
            workspaceCandidate: null,
            packageCandidate,
            explicitError: { scope: 'manifest', file: pkgManifest, reason: 'invalid-workspace-config' },
          };
        }
        const explicitDir = resolveRelativeDir(dir, entry.doc.package.workspace);
        if (explicitDir === null) {
          return {
            workspaceCandidate: null,
            packageCandidate,
            explicitError: { scope: 'manifest', file: pkgManifest, reason: 'unsafe-path' },
          };
        }
        const wsEntry = manifestDirs.has(explicitDir) ? parsedCache(explicitDir) : { error: 'missing' };
        if (!wsEntry.error && !isPlainObject(wsEntry.doc.workspace)) {
          const wsManifest = explicitDir ? `${explicitDir}/Cargo.toml` : 'Cargo.toml';
          return {
            workspaceCandidate: null,
            packageCandidate,
            explicitError: { scope: 'workspace', file: wsManifest, reason: 'missing-cargo-workspace' },
          };
        }
        return {
          workspaceCandidate: { rootDir: explicitDir, entry: wsEntry },
          packageCandidate,
        };
      }
    }
    if (workspaceCandidate !== null) break;
  }
  return { workspaceCandidate, packageCandidate };
}

function isNestedWorkspaceRoot(rootDir, candidateDir, manifestDirs, parsedCache) {
  if (candidateDir === rootDir || !manifestDirs.has(candidateDir)) return false;
  const parsed = parsedCache(candidateDir);
  return !parsed.error && isPlainObject(parsed.doc.workspace);
}

function parseExcludePrefixes(workspace, rootDir, rootManifest, unknown) {
  const prefixes = [];
  if (workspace.exclude === undefined) return prefixes;
  if (!Array.isArray(workspace.exclude)) {
    unknown('workspace', rootManifest, 'invalid-workspace-config');
    return prefixes;
  }
  for (const item of workspace.exclude) {
    const normalized = normalizeWorkspacePath(item, { allowGlob: true });
    if (normalized === null) {
      unknown('workspace', rootManifest, 'unsafe-path');
      continue;
    }
    // Cargo `exclude` matches directory subtrees literally (not as globs).
    if (!hasGlobMeta(normalized)) prefixes.push(joinRel(rootDir, normalized));
  }
  return prefixes;
}

function collectDeclaredMembers({
  workspace,
  rootDir,
  rootManifest,
  manifestDirs,
  snapshotDirs,
  snapshotFiles,
  parsedCache,
  isExcluded,
  unknown,
}) {
  const selected = new Set();
  if (workspace.members === undefined) return selected;
  if (!Array.isArray(workspace.members)) {
    unknown('workspace', rootManifest, 'invalid-workspace-config');
    return selected;
  }
  for (const item of workspace.members) {
    const pattern = normalizeWorkspacePath(item, { allowGlob: true });
    if (pattern === null) {
      unknown('workspace', rootManifest, 'unsafe-path');
      continue;
    }
    if (!hasGlobMeta(pattern)) {
      const memberDir = joinRel(rootDir, pattern);
      if (!manifestDirs.has(memberDir)) {
        unknown('workspace', rootManifest, 'missing-workspace-member');
        continue;
      }
      if (isNestedWorkspaceRoot(rootDir, memberDir, manifestDirs, parsedCache)) {
        unknown('workspace', `${memberDir}/Cargo.toml`, 'nested-workspace-root');
        continue;
      }
      selected.add(memberDir);
      continue;
    }
    const regex = compileCargoGlob(pattern);
    if (!regex) {
      unknown('workspace', rootManifest, 'unsupported-member-glob');
      continue;
    }
    const matchedDirs = [...snapshotDirs]
      .filter(dir => {
        const rel = relativeToRoot(rootDir, dir);
        return rel !== null && rel !== '' && regex.test(rel);
      })
      .sort(compare);
    const matchedAnyFile = [...snapshotFiles].some(file => {
      const rel = relativeToRoot(rootDir, file);
      return rel !== null && regex.test(rel);
    });
    if (!matchedDirs.length && !matchedAnyFile) {
      unknown('workspace', rootManifest, 'member-glob-no-match');
      continue;
    }
    for (const dir of matchedDirs) {
      if (isExcluded(dir)) continue;
      if (!manifestDirs.has(dir)) {
        unknown('workspace', joinRel(dir, 'Cargo.toml'), 'member-without-manifest');
        continue;
      }
      if (isNestedWorkspaceRoot(rootDir, dir, manifestDirs, parsedCache)) {
        unknown('workspace', `${dir}/Cargo.toml`, 'nested-workspace-root');
        continue;
      }
      selected.add(dir);
    }
  }
  return selected;
}

function resolveDepTargetDir(dep, dir, rootDir, workspaceDependencies) {
  const spec = dep.spec;
  if (!isPlainObject(spec)) return null;
  if (spec.workspace === true) {
    const inherited = workspaceDependencies.get(dep.key);
    if (!inherited?.valid || inherited.path === null) return null;
    const rel = resolveRelativeDir('', inherited.path);
    return rel !== null ? joinRel(rootDir, rel) : null;
  }
  if (typeof spec.path !== 'string') return null;
  const relFromRoot = relativeToRoot(rootDir, dir);
  if (relFromRoot === null) return null;
  const resolvedRel = resolveRelativeDir(relFromRoot, spec.path);
  return resolvedRel !== null ? joinRel(rootDir, resolvedRel) : null;
}

function expandPathMembers({
  selected,
  rootDir,
  workspaceDependencies,
  workspacePackage,
  manifestDirs,
  parsedCache,
  isExcluded,
  unknown,
}) {
  const queue = [...selected].sort(compare);
  const visited = new Set(queue);
  while (queue.length) {
    const dir = queue.shift();
    const parsed = parsedCache(dir);
    if (parsed.error) continue;
    const { edition } = resolvePackageEdition(parsed.doc, workspacePackage);
    for (const dep of collectManifestDependencies(parsed.doc, { edition: edition ?? '2015' })) {
      const targetDir = resolveDepTargetDir(dep, dir, rootDir, workspaceDependencies);
      if (targetDir === null || !manifestDirs.has(targetDir) || isExcluded(targetDir)) continue;
      if (isNestedWorkspaceRoot(rootDir, targetDir, manifestDirs, parsedCache)) {
        unknown('workspace', `${targetDir}/Cargo.toml`, 'nested-workspace-root');
        continue;
      }
      if (!visited.has(targetDir)) {
        visited.add(targetDir);
        selected.add(targetDir);
        queue.push(targetDir);
      }
    }
  }
}

function loadMemberPackages(selected, parsedCache, workspacePackage, unknown) {
  const members = [];
  const seenNames = new Set();
  for (const dir of [...selected].sort(compare)) {
    const manifest = dir ? `${dir}/Cargo.toml` : 'Cargo.toml';
    const parsed = parsedCache(dir);
    if (parsed.error) {
      unknown('manifest', manifest, 'parse-error', 0);
      continue;
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
    for (const dir of ancestorsOf(parent === '.' ? '' : parent)) snapshotDirs.add(dir);
  };
  for (const file of rawMap.keys()) addFile(file);
  if (Array.isArray(files)) {
    for (const entry of files) addFile(entry);
  }
  return { snapshotDirs, snapshotFiles };
}

function resolveWorkspaceAtRoot({ rootDir, rootEntry, manifestDirs, snapshotDirs, snapshotFiles, parsedCache }) {
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
  const excludePrefixes = parseExcludePrefixes(workspace, rootDir, rootManifest, unknown);
  const isExcluded = dir => excludePrefixes.some(ex => (ex === '' ? true : dir === ex || dir.startsWith(`${ex}/`)));

  const selected = hasWorkspace
    ? collectDeclaredMembers({
        workspace,
        rootDir,
        rootManifest,
        manifestDirs,
        snapshotDirs,
        snapshotFiles,
        parsedCache,
        isExcluded,
        unknown,
      })
    : new Set();
  if (hasRootPackage) selected.add(rootDir);

  if (hasWorkspace) {
    expandPathMembers({
      selected,
      rootDir,
      workspaceDependencies,
      workspacePackage,
      manifestDirs,
      parsedCache,
      isExcluded,
      unknown,
    });
  }

  const members = loadMemberPackages(selected, parsedCache, workspacePackage, unknown);
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

/**
 * Resolve a Cargo workspace offline using Cargo's member/exclude/path-dependency rules.
 * @param {{ manifests: Map<string, Buffer | string> | Record<string, Buffer | string>, files?: Array<string | { path: string }>, startDir?: string }} input
 */
export function resolveCargoWorkspace({ manifests, files, startDir = '' }) {
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

  const cleanStart = normalizeWorkspacePath(startDir === '' ? '.' : startDir) ?? '';
  const { workspaceCandidate, packageCandidate, explicitError } = findCandidateRoots(
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
  const resolveFrom = candidate =>
    resolveWorkspaceAtRoot({
      rootDir: candidate.rootDir,
      rootEntry: candidate.entry,
      manifestDirs,
      snapshotDirs,
      snapshotFiles,
      parsedCache,
    });

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
  if (wsResolved.isExcluded(packageCandidate.rootDir)) {
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
