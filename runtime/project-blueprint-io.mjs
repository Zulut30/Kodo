// Bounded, link-free reads of the project factory blueprint
// (`project-blueprint.mjs`): blueprint files and interfaces, committed root
// entries, optional architecture and toolchain files and interface evidence.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { blueprintScopeBranches } from './cargo-workspace.mjs';
import { plannedPackageDirs } from './project-blueprint-cargo-scopes.mjs';
import { pathParents, scopeIndexPrefix, scopeOwnership } from './project-blueprint-scope-index.mjs';
import { execute, gitBoundary } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { inside } from './toolchains.mjs';
import {
  BLUEPRINT_LIMITS,
  compare,
  failure,
  finding,
  isPlain,
  shown,
  slashed,
  windowsLike,
} from './project-blueprint-shared.mjs';

const MODULE = /^[a-z][a-z0-9-]{0,47}$/;
const ZERO_DIGEST = '0'.repeat(64);
/** Read one regular, unlinked file with a byte cap, as strict UTF-8. Errors carry
 * blueprint_* codes. The open handle is compared with lstat to resist swaps. */
export async function readBoundedFile(file, maxBytes) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('blueprint_missing', `Нет файла ${path.basename(file)}`);
    throw error;
  }
  const name = path.basename(file);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
    throw failure('blueprint_unsafe_path', `${name}: ссылка, жёсткая ссылка или не обычный файл`);
  if (info.size > maxBytes) throw failure('blueprint_too_large', `${name}: больше ${maxBytes} байт`);
  const handle = await open(file, 'r');
  let bytes;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.nlink > 1)
      throw failure('blueprint_unsafe_path', `${name}: файл подменён во время чтения`);
    const buffer = Buffer.alloc(Math.min(current.size, maxBytes) + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw failure('blueprint_too_large', `${name}: больше ${maxBytes} байт`);
    bytes = buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw failure('blueprint_encoding', `${name}: не UTF-8`);
  }
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text };
}
async function safeDirectory(directory, required) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (required) throw failure('blueprint_missing', `Нет каталога ${path.basename(directory)}`);
    return false;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw failure('blueprint_unsafe_path', `${path.basename(directory)}: ссылка или не каталог`);
  return true;
}
export async function projectRoot(root) {
  if (typeof root !== 'string' || !root) throw failure('blueprint_missing', 'Не указан каталог проекта');
  let real;
  try {
    real = await realpath(path.resolve(root));
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('blueprint_missing', 'Каталог проекта не существует');
    throw error;
  }
  if (!(await stat(real)).isDirectory()) throw failure('blueprint_missing', 'Каталог проекта не является каталогом');
  return real;
}
async function readInterfaces(directory) {
  const folder = path.join(directory, 'interfaces');
  if (!(await safeDirectory(folder, false))) return [];
  const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
  if (entries.length > BLUEPRINT_LIMITS.interfaces)
    throw failure('blueprint_too_large', `interfaces/: больше ${BLUEPRINT_LIMITS.interfaces} файлов`);
  const result = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw failure('blueprint_unsafe_path', `interfaces/${shown(entry.name)}: ссылка`);
    const match = /^(.+)\.md$/.exec(entry.name);
    if (!entry.isFile() || !match || !MODULE.test(match[1]))
      throw failure('blueprint_interface_name', `interfaces/${shown(entry.name)}: ожидается <module>.md (slug)`);
    const file = await readBoundedFile(path.join(folder, entry.name), BLUEPRINT_LIMITS.interface);
    total += file.bytes;
    if (total > BLUEPRINT_LIMITS.interfacesTotal)
      throw failure('blueprint_too_large', `interfaces/: больше ${BLUEPRINT_LIMITS.interfacesTotal} байт`);
    result.push({ module: match[1], path: `interfaces/${entry.name}`, sha256: file.sha256, bytes: file.bytes });
  }
  return result;
}
/** Read PROJECT.md, spec.json and interfaces/*.md from <root>/.kodo/blueprint.
 * `specFile` replaces spec.json by another file (same limits and link rules).
 * Rejects links, hard links, special files, oversized or non-UTF-8 content.
 * @param {string} root
 * @param {{ specFile?: string }} [options] */
export async function readBlueprint(root, { specFile } = {}) {
  return readBlueprintAtRoot(await projectRoot(root), specFile);
}

/** Read draft files at the canonical directory returned by projectRoot().
 * @param {string} real
 * @param {string | undefined} specFile */
export async function readBlueprintAtRoot(real, specFile) {
  const directory = path.join(real, '.kodo', 'blueprint');
  await safeDirectory(path.join(real, '.kodo'), true);
  await safeDirectory(directory, true);
  if (!inside(real, await realpath(directory))) throw failure('blueprint_unsafe_path', 'Чертёж вне каталога проекта');
  const project = await readBoundedFile(path.join(directory, 'PROJECT.md'), BLUEPRINT_LIMITS.project);
  if (specFile !== undefined && (typeof specFile !== 'string' || !specFile))
    throw failure('blueprint_missing', 'Не указан файл spec');
  const specPath = specFile === undefined ? path.join(directory, 'spec.json') : path.resolve(specFile);
  const spec = await readBoundedFile(specPath, BLUEPRINT_LIMITS.spec);
  const specName = path.basename(specPath);
  let value;
  try {
    value = JSON.parse(spec.text);
  } catch {
    throw failure('blueprint_invalid_json', `${specName} не является JSON`);
  }
  return {
    root: real,
    dir: directory,
    project: { path: 'PROJECT.md', sha256: project.sha256, bytes: project.bytes, text: project.text },
    spec: { path: specFile === undefined ? 'spec.json' : specName, sha256: spec.sha256, bytes: spec.bytes, value },
    interfaces: await readInterfaces(directory),
  };
}
// ---- Compile -------------------------------------------------------------------

function interfaceModule(value, root) {
  const text = value.replaceAll('\\', '/');
  let relative;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    const fold = windowsLike(root) ? item => item.toLowerCase() : item => item;
    const base = `${slashed(root)}/.kodo/blueprint/`;
    relative = fold(text).startsWith(fold(base)) ? text.slice(base.length) : null;
  } else relative = text.replace(/^\.\//, '').replace(/^\.kodo\/blueprint\//, '');
  const match = relative && /^interfaces\/([a-z][a-z0-9-]{0,47})\.md$/.exec(relative);
  return match ? match[1] : null;
}
// Blueprint shorthand: { kind?: 'interface', path: 'interfaces/<module>.md' } with
// optional runId/headSha/sha256. It resolves to a full Ref with the current file
// digest. A missing interface gets a zero digest; lint then reports it.
function resolveRefs(task, root, interfaces) {
  const refs = [],
    unresolved = [];
  for (const ref of task.interfaceRefs) {
    if (!isPlain(ref) || typeof ref.path !== 'string') {
      refs.push(ref);
      continue;
    }
    const module = interfaceModule(ref.path, root);
    const relative = !(path.isAbsolute(ref.path) || path.win32.isAbsolute(ref.path));
    if (module === null) {
      if (relative) unresolved.push(task.id);
      else refs.push(ref);
      continue;
    }
    refs.push({
      ...ref,
      kind: ref.kind ?? 'interface',
      runId: ref.runId ?? null,
      headSha: ref.headSha ?? null,
      path: path.join(root, '.kodo', 'blueprint', 'interfaces', `${module}.md`),
      sha256: ref.sha256 ?? interfaces.find(item => item.module === module)?.sha256 ?? ZERO_DIGEST,
    });
  }
  return { refs, unresolved };
}
async function sameDirectory(declared, real) {
  if (!path.isAbsolute(declared)) return true; // normalizeProjectSpec reports non-absolute roots.
  const resolved = await realpath(declared).catch(() => path.resolve(declared));
  const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  return fold(path.resolve(resolved)) === fold(real);
}
export async function resolveSource({ root, spec, interfaces }) {
  if (!isPlain(spec.value)) return { value: spec.value, findings: [] };
  const value = structuredClone(spec.value),
    findings = [],
    unresolved = new Set();
  if (typeof value.root === 'string') {
    if (await sameDirectory(value.root, root)) value.root = root;
    else findings.push(finding('blueprint_root_mismatch', 'root в spec.json не совпадает с каталогом проекта'));
  }
  if (Array.isArray(value.tasks))
    for (const task of value.tasks) {
      if (!isPlain(task) || !Array.isArray(task.interfaceRefs)) continue;
      const result = resolveRefs(task, root, interfaces);
      task.interfaceRefs = result.refs;
      for (const id of result.unresolved) unresolved.add(id);
    }
  if (unresolved.size)
    findings.push(
      finding(
        'blueprint_interface_missing',
        'Относительный path в interfaceRefs должен иметь вид interfaces/<module>.md',
        [...unresolved].map(String),
      ),
    );
  return { value, findings };
}
const gitRead = (cwd, args, env = workerEnvironment()) =>
  execute('git', ['--literal-pathspecs', ...args], {
    cwd,
    env: { ...env, LC_ALL: 'C' },
    rawOutput: true,
    allowFailure: true,
    timeoutMs: 10000,
  });

// Keep literal pathspecs within Windows' command-line limit even for a large plan.
function* pathspecBatches(files) {
  let batch = [],
    length = 0;
  for (const file of files) {
    if (batch.length && length + file.length > 16000) {
      yield batch;
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += file.length + 3;
  }
  if (batch.length) yield batch;
}

const execFileAsync = promisify(execFile);
const metadataFailure = () =>
  failure(
    'blueprint_cargo_evidence_unavailable',
    'Не удалось прочитать архитектурную политику или имена пакетов Cargo в выбранном коммите Git',
  );

// Unlike the text command runner, execFile returns raw bytes for strict UTF-8 validation.
async function readMetadataBlob(root, oid, size, gitEnv) {
  const { args, env } = gitBoundary(['cat-file', 'blob', oid], gitEnv);
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    env,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: size,
    encoding: 'buffer',
  });
  const hash = createHash(oid.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${size}\0`)
    .update(stdout)
    .digest('hex');
  if (stdout.length !== size || hash !== oid) throw metadataFailure();
  return new TextDecoder('utf-8', { fatal: true }).decode(stdout);
}

/** Draft metadata is best effort. With a selected commit only an absent path
 * has no metadata. A present entry must be a readable, bounded regular blob.
 * @template T
 * @param {string} root
 * @param {string[]} files Literal paths relative to the blueprint root
 * @param {number} maxBytes
 * @param {string | null} revision
 * @param {(text: string) => T} parse
 * @param {Map<string, T>} [parsed] Blobs already verified with this parser and size limit.
 * @returns {Promise<Map<string, T>>}
 */
export async function readOptionalBlueprintMetadata(root, files, maxBytes, revision, parse, parsed = new Map()) {
  const values = new Map();
  if (!revision) {
    for (const file of files) {
      try {
        values.set(file, parse((await readBoundedFile(path.join(root, file), maxBytes)).text));
      } catch {
        // Standalone compile/bootstrap may be working with incomplete draft metadata.
      }
    }
    return values;
  }
  try {
    const gitEnv = { ...workerEnvironment(), GIT_NO_LAZY_FETCH: '1' };
    for (const batch of pathspecBatches(files)) {
      const tree = await gitRead(root, ['ls-tree', '-l', '-z', revision, '--', ...batch], gitEnv);
      if (tree.code !== 0 || tree.stderr.trim()) throw metadataFailure();
      for (const row of tree.stdout.split('\0').filter(Boolean)) {
        const entry = /^100(?:644|755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?) +(\d+)\t([\s\S]+)$/.exec(row);
        if (!entry || Number(entry[2]) > maxBytes) throw metadataFailure();
        const [, oid, size, file] = entry;
        if (!parsed.has(oid)) parsed.set(oid, parse(await readMetadataBlob(root, oid, Number(size), gitEnv)));
        values.set(file, parsed.get(oid));
      }
    }
    return values;
  } catch {
    throw metadataFailure();
  }
}

export async function readOptionalArchitecturePolicy(root, revision = null) {
  const file = 'architecture.policy.json';
  const policies = await readOptionalBlueprintMetadata(root, [file], BLUEPRINT_LIMITS.spec, revision, JSON.parse);
  const policy = policies.get(file);
  return isPlain(policy) ? policy : null;
}
/** The blueprint root relative to its Git top-level ('' at the top), or null when
 * the real root lies outside that repository (e.g. reached through a link). */
async function repositoryPrefix(root) {
  const top = await gitRead(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || typeof top.stdout !== 'string' || !top.stdout.trim()) return null;
  const realTop = await realpath(top.stdout.trim());
  const realRoot = await realpath(root);
  const fold = windowsLike(realRoot) ? value => value.toLowerCase() : value => value;
  if (!inside(fold(realTop), fold(realRoot))) return null;
  const relative = path.relative(realTop, realRoot);
  const parts = relative ? relative.split(path.sep) : [];
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return { top: realTop, parts };
}
/** A regular blob committed at HEAD: `file` in the blueprint root or, with
 * `ancestors`, the nearest one in a parent directory up to the Git top-level. */
async function readCommittedRootEntry(root, file, { ancestors = false, revision = 'HEAD^{commit}' } = {}) {
  try {
    const repository = await repositoryPrefix(root);
    if (!repository) return null;
    const { top, parts } = repository;
    const candidates = [];
    for (let depth = parts.length; depth >= (ancestors ? 0 : parts.length); depth--)
      candidates.push([...parts.slice(0, depth), file].join('/'));
    const ls = await gitRead(top, ['ls-tree', '-z', '--full-tree', revision, '--', ...candidates]);
    if (ls.code !== 0 || typeof ls.stdout !== 'string') return null;
    const entries = new Map();
    for (const row of ls.stdout.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(row);
      if (match) entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
    }
    const nearest = candidates.find(candidate => entries.has(candidate));
    if (!nearest) return null;
    const entry = entries.get(nearest);
    return (entry.mode === '100644' || entry.mode === '100755') && entry.type === 'blob' ? { oid: entry.oid } : null;
  } catch {
    return null;
  }
}
const cargoEvidenceFailure = () =>
  failure('blueprint_cargo_evidence_unavailable', 'Не удалось проверить манифесты Cargo и исходники в Git HEAD');

async function entryInfo(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function hasGitMarker(directory) {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    if (await entryInfo(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// Only an absent current branch is unborn. A ref can exist even when it is
// malformed or points at an unavailable object.
async function isUnbornBranch(root) {
  const target = await gitRead(root, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD']);
  const ref = target.stdout.trim();
  if (target.code !== 0 || !ref.startsWith('refs/heads/')) return false;
  const exists = await gitRead(root, ['show-ref', '--exists', ref]);
  if (exists.code !== 129) return exists.code === 2;
  // Older Git can silently omit a dangling symbolic ref from enumeration.
  // Check both the packed listing and the exact loose entry in that backend.
  const listing = await gitRead(root, ['for-each-ref', '--format=%(refname)', ref]);
  if (listing.code !== 0 || listing.stderr.trim() || listing.stdout.trimEnd().split(/\r?\n/).includes(ref))
    return false;
  const pointer = await gitRead(root, ['rev-parse', '--git-path', ref]);
  if (pointer.code !== 0 || !pointer.stdout.trimEnd()) return false;
  const loose = await entryInfo(path.resolve(root, pointer.stdout.trimEnd()));
  return !loose || loose.isDirectory();
}

/** Pin one commit for every Git evidence read in a compilation. */
export async function readBlueprintCommit(root) {
  try {
    const head = await gitRead(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const oid = head.stdout.trim();
    if (head.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) return oid;
    if (head.code === 1 && (await isUnbornBranch(root))) return null;
    if (head.code === 128 && head.stderr.startsWith('fatal: not a git repository') && !(await hasGitMarker(root)))
      return null;
  } catch {
    throw cargoEvidenceFailure();
  }
  throw cargoEvidenceFailure();
}

export function blueprintWriteScopes(spec) {
  const scopes = new Set();
  for (const task of Array.isArray(spec?.tasks) ? spec.tasks : [])
    for (const scope of Array.isArray(task?.writePaths) ? task.writePaths : [])
      if (typeof scope === 'string' && scope) scopes.add(scope.replace(/^\.\//, ''));
  return scopes;
}

function namedScopeEntries(scopes) {
  const named = new Set();
  const add = file => {
    named.add(file);
    for (const parent of pathParents(file)) named.add(parent);
  };
  for (const scope of scopes) {
    add(scope);
    for (const branch of blueprintScopeBranches(scope)) if (branch !== scope) add(branch);
  }
  return named;
}

// Keep the original Git spelling of the literal components guaranteed by
// the scope index. A scope without such a lead needs the whole project tree.
function cargoSearchLeads(scopes) {
  const leads = new Set();
  for (const scope of scopes) {
    const depth = scopeIndexPrefix(scope).segments.length;
    if (!depth) return new Set(['']);
    leads.add(scope.split('/').slice(0, depth).join('/'));
  }
  return leads;
}

// A draft may predate Git or include ignored manifests. Walk only the literal
// leads of the plan and their subtrees. Record names and types without following
// links or opening a manifest before its ownership is known.
async function draftCargoTree(root, scopes) {
  const manifests = new Map(),
    sources = [],
    entryKinds = new Map();
  const named = namedScopeEntries(scopes);
  const leads = cargoSearchLeads(scopes),
    ancestors = new Set();
  for (const lead of leads) for (const parent of pathParents(lead)) ancestors.add(parent);
  async function visit(dir, subtree) {
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return; // Draft metadata is best effort.
    }
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git') continue;
      const file = dir ? dir + '/' + entry.name : entry.name;
      if (named.has(file)) entryKinds.set(file, entry.isDirectory() ? 'tree' : 'leaf');
      if (entry.name === 'Cargo.toml') {
        manifests.set(dir || '.', '');
      } else if (entry.isDirectory()) {
        const below = subtree || leads.has(file);
        if (below || ancestors.has(file)) await visit(file, below);
      } else if (entry.isFile() && file.endsWith('.rs')) sources.push(file);
    }
  }
  await visit('', leads.has(''));
  return { manifests, sources, entryKinds };
}

function cargoTreePathspecs(scopes) {
  const leads = cargoSearchLeads(scopes);
  if (leads.has('')) return ['.'];
  const files = new Set(['Cargo.toml', ...leads]);
  for (const lead of leads) for (const parent of pathParents(lead)) files.add(parent + '/Cargo.toml');
  return [...files].filter(file => ![...pathParents(file)].some(parent => leads.has(parent)));
}

function unresolvedTreeParents(files, entryKinds) {
  const unresolved = new Set();
  for (const file of files) {
    const dir = [...pathParents(file)].reverse().find(parent => entryKinds.get(parent) !== 'tree');
    if (dir && !entryKinds.has(dir)) unresolved.add(dir);
  }
  return unresolved;
}

// Git returns paths relative to the blueprint root. Keep scope matching outside
// the stdout callback so repository size cannot turn a match into a Git timeout.
async function committedCargoTree(root, revision, scopes, includePlanned = true) {
  const options = {
    cwd: root,
    env: { ...workerEnvironment(), LC_ALL: 'C', GIT_NO_LAZY_FETCH: '1' },
    rawOutput: true,
    allowFailure: true,
    timeoutMs: 10000,
  };
  const manifests = new Map();
  const sources = [];
  const entryKinds = new Map();
  const named = namedScopeEntries(scopes);
  let tail = '';
  function consumeStdout(chunk) {
    const rows = (tail + chunk).split('\0');
    tail = rows.pop();
    for (const row of rows) {
      const split = row.indexOf('\t');
      const name = row.slice(split + 1);
      // Only exact names and ancestors from the plan need their Git type.
      if (named.has(name)) entryKinds.set(name, row.startsWith('040000 tree ') ? 'tree' : 'leaf');
      const regular = row.startsWith('100644 blob ') || row.startsWith('100755 blob ');
      if (name === 'Cargo.toml' || name.endsWith('/Cargo.toml'))
        manifests.set(path.posix.dirname(name), regular ? row.slice('100644 blob '.length, split) : null);
      else if (regular && name.endsWith('.rs')) sources.push(name);
    }
  }
  async function list(files, flags) {
    for (const paths of pathspecBatches(files)) {
      const tree = await execute('git', ['--literal-pathspecs', 'ls-tree', ...flags, '-z', revision, '--', ...paths], {
        ...options,
        consumeStdout,
      });
      if (tree.code !== 0 || tree.stderr.trim() || tail) throw cargoEvidenceFailure();
    }
  }
  const files = cargoTreePathspecs(scopes);
  await list(files, ['-r', '-t']);
  // ls-tree -- file/child reports existing parent trees but omits a blob at
  // "file". Ask for the first unresolved parent itself to distinguish that
  // blob from a directory the plan can create, without recursing or opening
  // file contents. A toolchain check only needs to inspect existing packages.
  if (includePlanned || manifests.size) await list(unresolvedTreeParents(files, entryKinds), []);
  return { manifests, sources, entryKinds };
}

export async function readBlueprintCargoTree(root, scopes, revision) {
  if (!revision) return draftCargoTree(root, scopes);
  try {
    return await committedCargoTree(root, revision, scopes);
  } catch {
    throw cargoEvidenceFailure();
  }
}

// A manifest scope owns that entry regardless of its contents. A source scope
// belongs only to the nearest manifest, even if that manifest is virtual.
export function* scopedCargoDirs(scopes, { manifests, sources, entryKinds }) {
  if (!manifests.size || !scopes.size) return;
  const owns = scopeOwnership(scopes);
  for (const dir of manifests.keys()) {
    if (owns(dir === '.' ? 'Cargo.toml' : dir + '/Cargo.toml')) yield { dir, manifest: true };
  }
  const planned = plannedPackageDirs(scopes, manifests, entryKinds);
  for (const dir of planned) yield { dir, manifest: false };
  for (const file of sources) {
    if (!owns(file)) continue;
    const dir = [...pathParents(file)].find(parent => manifests.has(parent)) ?? '.';
    if (manifests.has(dir) && !planned.has(dir)) {
      planned.add(dir);
      yield { dir, manifest: false };
    }
  }
}

export async function hasCommittedCargoManifest(root, spec = null, revision = undefined, tree = undefined) {
  try {
    const commit = revision ?? (await readBlueprintCommit(root));
    if (!commit) return false;
    const scopes = blueprintWriteScopes(spec);
    const { manifests: entries, sources, entryKinds } = tree ?? (await committedCargoTree(root, commit, scopes, false));
    // Toolchain detection uses regular manifests only. Contract metadata reads
    // below a selected non-regular entry still fail their strict blob check.
    const manifests = new Map([...entries].filter(([, oid]) => oid !== null));
    if (!manifests.size) return false;
    if (manifests.has('.')) return true;
    if (!scopes.size) return false;
    // A virtual workspace groups packages; it is not the owning package of a
    // fixture. Inspect the committed blob only when a scope can touch a source.
    const packageBlobs = new Map();
    async function isPackage(dir) {
      const oid = manifests.get(dir);
      if (!packageBlobs.has(oid)) {
        const blob = await gitRead(root, ['cat-file', 'blob', oid]);
        if (blob.code !== 0) throw cargoEvidenceFailure();
        const doc = parseToml(blob.stdout);
        packageBlobs.set(oid, isPlain(doc.package) || isPlain(doc.project));
      }
      return packageBlobs.get(oid);
    }
    for (const { dir, manifest } of scopedCargoDirs(scopes, { manifests, sources, entryKinds }))
      if (manifest || (await isPackage(dir))) return true;
    return false;
  } catch {
    throw cargoEvidenceFailure();
  }
}
export async function readOptionalRustToolchain(root, revision = 'HEAD^{commit}') {
  const entry = await readCommittedRootEntry(root, 'rust-toolchain.toml', { ancestors: true, revision });
  if (!entry) return false;
  try {
    const sizeOut = await execute('git', ['cat-file', '-s', entry.oid], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    const size = Number(sizeOut.stdout?.trim());
    if (sizeOut.code !== 0 || !Number.isSafeInteger(size) || size < 0 || size > BLUEPRINT_LIMITS.project) return false;
    const blob = await execute('git', ['cat-file', 'blob', entry.oid], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (blob.code !== 0 || typeof blob.stdout !== 'string' || Buffer.byteLength(blob.stdout) > BLUEPRINT_LIMITS.project)
      return false;
    const doc = parseToml(blob.stdout);
    const tc = /** @type {Record<string, any> | null} */ (isPlain(doc?.toolchain) ? doc.toolchain : null);
    const channel = typeof tc?.channel === 'string' ? tc.channel.trim() : '';
    const exactChannel = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(channel);
    const components = Array.isArray(tc?.components) ? tc.components : [];
    return exactChannel && components.includes('clippy') && components.includes('rustfmt');
  } catch {
    return false;
  }
}
// ---- Interface evidence --------------------------------------------------------

/** Freeze every interface of a compiled blueprint as an immutable evidence
 * envelope and point task interfaceRefs at it, so Project Director can verify
 * them (engine.assertEvidence). `persist(value)` is the caller's port, e.g.
 * engine.persistEvidence(owner, 'interface', value, { headSha: null }), and
 * returns { path, sha256 }. Files are re-read first: a change since compile
 * yields blueprint_interface_stale and nothing is persisted.
 * Returns { ok, spec, interfaces: [{ module, source, path, sha256 }], findings }.
 * @param {Record<string, any>} compiled
 * @param {{ persist?: (value: Record<string, any>) => Promise<{ path: string, sha256: string }> }} [options] */
export async function bindInterfaceEvidence(compiled, { persist } = {}) {
  if (!compiled?.ok || !isPlain(compiled.spec) || !Array.isArray(compiled.interfaces))
    throw failure('blueprint_not_compiled', 'Привязать интерфейсы можно только у принятого чертежа');
  if (typeof persist !== 'function') throw failure('blueprint_persist_invalid', 'Нужен порт persist');
  const root = compiled.spec.root;
  const directory = path.join(root, '.kodo', 'blueprint');
  const fold = windowsLike(root) ? value => value.toLowerCase() : value => value;
  const used = new Set(
    compiled.spec.tasks.flatMap(task => task.interfaceRefs.map(ref => interfaceModule(ref.path, root))),
  );
  const values = [],
    stale = [];
  for (const item of compiled.interfaces.filter(entry => used.has(entry.module))) {
    let file;
    try {
      file = await readBoundedFile(path.join(directory, ...item.path.split('/')), BLUEPRINT_LIMITS.interface);
    } catch (error) {
      if (!String(error?.code).startsWith('blueprint_')) throw error;
      file = null;
    }
    if (!file || file.sha256 !== item.sha256) stale.push(item.module);
    else
      values.push({
        schemaVersion: 1,
        module: item.module,
        source: item.path,
        sha256: item.sha256,
        bytes: file.bytes,
        text: file.text,
      });
  }
  if (stale.length) {
    const ids = compiled.spec.tasks
      .filter(task => task.interfaceRefs.some(ref => stale.includes(interfaceModule(ref.path, root))))
      .map(task => task.id);
    const message = 'Интерфейсы изменились после проверки чертежа; повторите apply-spec';
    return { ok: false, spec: null, interfaces: [], findings: [finding('blueprint_interface_stale', message, ids)] };
  }
  const interfaces = [];
  for (const value of values) {
    const evidence = await persist(value);
    interfaces.push({ module: value.module, source: value.source, path: evidence.path, sha256: evidence.sha256 });
  }
  const byModule = new Map(interfaces.map(item => [item.module, item]));
  const spec = structuredClone(compiled.spec);
  for (const task of spec.tasks)
    task.interfaceRefs = task.interfaceRefs.map(ref => {
      const evidence = byModule.get(interfaceModule(ref.path, root));
      if (!evidence || fold(slashed(ref.path)) !== fold(`${slashed(directory)}/${evidence.source}`))
        throw failure('blueprint_not_compiled', 'interfaceRefs не указывают на интерфейсы чертежа');
      return { kind: 'interface', runId: null, headSha: null, path: evidence.path, sha256: evidence.sha256 };
    });
  return { ok: true, spec, interfaces, findings: [] };
}
