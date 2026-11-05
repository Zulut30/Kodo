import path from 'node:path';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { inspectJavaScriptModule } from './javascript-dependencies.mjs';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { noLinks } from './toolchains.mjs';

const sorted = values => [...new Set(values)].sort();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const javascript = file => /\.(?:mjs|cjs|js)$/.test(file);
const unsupported = file => /\.(?:ts|tsx|mts|cts|jsx|vue|svelte|py|pyi|go|rs|cs|vb|fs|fsx|java|kt|rb|php|ps1|sh|bash|c|h|cpp|cc|hpp|swift|scala|ex|exs|clj|lua|dart)$/.test(file);
const testFile = file => /(?:^|\/)test\.(?:mjs|cjs|js)$/.test(file) || /(?:^|\/)(?:[^/]+[._-](?:test|spec)|test-[^/]+)\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/.test(file) || /(?:^|\/)(?:test|__tests__)\/.*\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/.test(file);
const lockFile = file => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file);
const manifestFile = file => /(?:^|\/)package\.json$/.test(file);

function relative(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid affected path');
  return file;
}
async function git(project, args, input) {
  const options = { cwd: project, input, env: workerEnvironment(), rawOutput: true, timeoutMs: 30000 };
  if (args[0] === 'status') {
    // Status itself can run clean/process filters when an equal-size tracked
    // file needs rehashing. Inspect names only; suppress drivers for this child,
    // without reading their commands, editing config or trusting their output.
    const config = await execute('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { ...options, allowFailure: true });
    const keys = config.stdout.split('\0').filter(Boolean);
    if (![0, 1].includes(config.code) || config.stdout.length > 65536 || keys.length > 256) throw new Error('Unknown Git filter configuration');
    const drivers = sorted(keys.map(key => {
      const match = /^(filter\.[^\x00-\x20=\x7f]+)\.(?:clean|smudge|process|required)$/i.exec(key);
      if (!match) throw new Error('Unknown Git filter configuration');
      return match[1];
    }));
    args = [...drivers.flatMap(driver => ['clean', 'smudge', 'process', 'required'].flatMap(key => ['-c', `${driver}.${key}=${key === 'required' ? 'false' : ''}`])), ...args];
  }
  return (await execute('git', args, options)).stdout;
}
async function revision(project, value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new Error('Affected graph requires a full commit SHA');
  const resolved = (await git(project, ['rev-parse', '--verify', `${value}^{commit}`])).trim();
  if (resolved !== value) throw new Error('Affected graph commit mismatch');
  return value;
}
async function snapshot(project, sha) {
  const entries = (await git(project, ['ls-tree', '-rz', '--full-tree', sha])).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Malformed Git tree');
    return { mode: match[1], type: match[2], oid: match[3], file: relative(match[4]) };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const readable = entries.filter(entry => entry.type === 'blob' && entry.mode !== '120000' && (javascript(entry.file) || manifestFile(entry.file)));
  // Git supplies object IDs; parser input is data, never imported or executed.
  const text = readable.length ? await git(project, ['cat-file', '--batch'], readable.map(entry => entry.oid).join('\n') + '\n') : '';
  const bytes = Buffer.from(text), sources = new Map(); let offset = 0;
  for (const entry of readable) {
    const end = bytes.indexOf(10, offset), header = bytes.subarray(offset, end).toString('ascii').split(' '), size = Number(header[2]);
    if (end < 0 || header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end + 1 + size >= bytes.length) throw new Error('Malformed Git blob batch');
    sources.set(entry.file, bytes.subarray(end + 1, end + 1 + size).toString('utf8')); offset = end + size + 2;
  }
  return { entries, sources };
}

/** Point-in-time tracked-byte check. Unknown scope/I/O is never proof of clean source. */
export async function inspectCurrentSource(input = {}) {
  try {
    let { project, headSha } = input;
    if (typeof project !== 'string' || !project || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha || '')) return 'unknown';
    project = path.resolve(project); await noLinks(project);
    project = await realpath(project);
    const state = async () => {
      // Porcelain v2 binds HEAD and dirty status to the same observation.
      // Optional headers are harmless, but exactly one full OID is authority.
      const output = await git(project, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
      if (!output.endsWith('\0')) throw new Error('Malformed Git source status');
      const records = output.slice(0, -1).split('\0'), heads = records.filter(row => row.startsWith('# branch.oid'));
      if (heads.length !== 1 || !/^# branch\.oid (?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(heads[0])) throw new Error('Unknown Git source HEAD');
      return heads[0].slice('# branch.oid '.length) !== headSha || records.some(row => !row.startsWith('# '));
    };
    // Overlap only metadata observations; drain every branch before evaluating
    // root, initial state, then tree in their original authority order.
    const [rootObservation, treeObservation, initialState] = await Promise.allSettled([
      git(project, ['rev-parse', '--show-toplevel']),
      git(project, ['ls-tree', '-rz', '--full-tree', headSha]),
      state()
    ]);
    if (rootObservation.status === 'rejected') throw rootObservation.reason;
    const root = path.resolve(rootObservation.value.trim());
    await noLinks(root);
    if (await realpath(root) !== project) return 'unknown';
    if (initialState.status === 'rejected') throw initialState.reason;
    if (initialState.value) return 'dirty';
    if (treeObservation.status === 'rejected') throw treeObservation.reason;
    const entries = treeObservation.value.split('\0').filter(Boolean);
    if (!entries.length || entries.length > 50000) return 'unknown';
    let total = 0;
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match || match[2].length !== headSha.length) return 'unknown';
      const [, mode, oid, name] = match;
      relative(name);
      // Reject OS aliases/streams and ambiguous names before touching source.
      if (name.length > 2048 || /[:\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return 'unknown';
      const file = path.join(project, name); await noLinks(file);
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1) return 'unknown';
      total += info.size;
      if (info.size > 16 * 1024 ** 2 || total > 128 * 1024 ** 2) return 'unknown';
      if (process.platform !== 'win32' && Boolean(info.mode & 0o111) !== (mode === '100755')) return 'dirty';
      // Read at most the observed size plus one byte. A growing/replaced file
      // cannot turn a bounded verification into an unbounded readFile().
      const handle = await open(file, 'r');
      let bytes;
      try {
        const opened = await handle.stat();
        const same = actual => actual.isFile() && actual.nlink === 1 && ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs'].every(key => actual[key] === info[key]);
        if (!same(opened)) return 'unknown';
        const buffer = Buffer.alloc(info.size + 1); let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        await noLinks(file);
        if (offset !== info.size || !same(await handle.stat()) || !same(await lstat(file))) return 'unknown';
        bytes = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      const gitHash = data => createHash(headSha.length === 40 ? 'sha1' : 'sha256').update(`blob ${data.length}\0`).update(data).digest('hex');
      if (gitHash(bytes) !== oid) {
        // Match security-gates' normal CRLF checkout compatibility without
        // invoking any project-defined clean/smudge filter or logging bytes.
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes) || gitHash(Buffer.from(text.replaceAll('\r\n', '\n'))) !== oid) return 'dirty';
      }
    }
    return await state() ? 'dirty' : 'clean';
  } catch { return 'unknown'; }
}
function staticDependencies(source, file, reasons) {
  const inspected = inspectJavaScriptModule({ source, file });
  for (const item of inspected.unsupported) {
    if (item.scope !== 'dependency') continue;
    reasons.add(`${item.reason === 'parse-error' ? 'parse-error' : 'dynamic-dependency'}:${file}`);
  }
  return sorted(inspected.dependencies.map(item => item.specifier));
}
function buildGraph(tree, reasons) {
  const files = new Set(tree.entries.map(entry => entry.file)), packages = new Map(), names = new Map(), edges = new Map(), publicEntries = new Set();
  for (const entry of tree.entries) {
    if (entry.mode === '120000' || entry.type !== 'blob') reasons.add(`unsupported-tree-entry:${entry.file}`);
    if (unsupported(entry.file)) reasons.add(`unsupported-syntax:${entry.file}`);
    if (!manifestFile(entry.file)) continue;
    try {
      const data = JSON.parse(tree.sources.get(entry.file)), root = path.posix.dirname(entry.file) === '.' ? '' : path.posix.dirname(entry.file);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('manifest');
      const pkg = { root, data }; packages.set(root, pkg);
      if (data.name) { if (names.has(data.name)) reasons.add(`ambiguous-package:${entry.file}`); names.set(data.name, pkg); }
      if (data.imports) reasons.add(`unsupported-package-imports:${entry.file}`);
      const addEntries = value => {
        if (typeof value === 'string') { if (value.startsWith('./') || !value.startsWith('.')) publicEntries.add(path.posix.join(root, value)); }
        else if (value && typeof value === 'object') Object.values(value).forEach(addEntries);
      };
      for (const field of ['main', 'module', 'types', 'exports', 'bin']) addEntries(data[field]);
      if (data.main === undefined && data.exports === undefined) publicEntries.add(path.posix.join(root, 'index.js'));
    } catch { reasons.add(`invalid-package:${entry.file}`); }
  }
  const owners = [...packages.values()].sort((a, b) => b.root.length - a.root.length);
  const owner = file => owners.find(pkg => !pkg.root || file.startsWith(pkg.root + '/'));
  function local(candidate) {
    if (candidate.startsWith('../') || path.posix.isAbsolute(candidate)) return null;
    return [candidate, ...['.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs', '/index.cjs'].map(ext => candidate + ext)].find(file => files.has(file)) || null;
  }
  function resolve(specifier, file) {
    if (isBuiltin(specifier)) {
      const name = specifier.replace(/^node:/, '');
      // Filesystem reads, child commands, VMs and workers can consume arbitrary
      // local source without an import edge. Do not pretend imports cover them.
      if (/^(?:fs(?:\/|$)|child_process$|vm$|worker_threads$|module$)/.test(name)) reasons.add(`runtime-dependency:${file}:${name}`);
      return `builtin:${name}`;
    }
    if (specifier.startsWith('.')) return local(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    if (/^(?:[A-Za-z]+:|\/|#)/.test(specifier)) return null;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const pkg = names.get(name);
    if (pkg) {
      const suffix = specifier.slice(name.length), exports = pkg.data.exports;
      let target;
      if (exports !== undefined) target = typeof exports === 'string' && !suffix ? exports : exports && typeof exports === 'object' ? exports[suffix ? `.${suffix}` : '.'] : undefined;
      else target = suffix ? '.' + suffix : pkg.data.main || 'index.js';
      if (typeof target !== 'string' || target.includes('*')) return null;
      return local(path.posix.join(pkg.root, target));
    }
    const data = owner(file)?.data;
    if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.hasOwn(data?.[key] || {}, name))) return `external:${specifier}`;
    return null;
  }
  for (const [file, source] of tree.sources) {
    if (!javascript(file)) continue;
    const resolved = [];
    for (const specifier of staticDependencies(source, file, reasons)) {
      const target = resolve(specifier, file);
      if (!target) { reasons.add(`unresolved-import:${file}:${specifier}`); continue; }
      resolved.push(target);
      if (!target.startsWith('builtin:') && !target.startsWith('external:') && !javascript(target) && !target.endsWith('.json')) reasons.add(`unsupported-import:${file}:${target}`);
    }
    edges.set(file, sorted(resolved));
  }
  return { edges, publicEntries };
}

/** Plan from immutable Git objects. Any uncertain edge forces the caller's full test runner. */
export async function planAffected({ project, baseSha, headSha, changedPaths = [] }) {
  project = path.resolve(project); await noLinks(project);
  // Reject links before resolving legitimate Windows case and 8.3 aliases.
  project = await realpath(project);
  if (await realpath(path.resolve((await git(project, ['rev-parse', '--show-toplevel'])).trim())) !== project) throw new Error('Affected project must be the repository root');
  if (!Array.isArray(changedPaths)) throw new Error('Invalid changed paths');
  changedPaths.forEach(relative);
  headSha = await revision(project, headSha || (await git(project, ['rev-parse', 'HEAD'])).trim());
  baseSha = await revision(project, baseSha || headSha);
  const head = await snapshot(project, headSha), base = baseSha === headSha ? head : await snapshot(project, baseSha), reasons = new Set();
  const currentHead = (await git(project, ['rev-parse', 'HEAD'])).trim();
  if (currentHead !== headSha) reasons.add('head-mismatch');
  if ((await git(project, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) reasons.add('dirty-worktree');
  const sourceState = await inspectCurrentSource({ project, headSha });
  if (sourceState === 'dirty' && currentHead === headSha) reasons.add('dirty-worktree');
  if (sourceState === 'unknown') reasons.add('unknown-source');
  const tokens = (await git(project, ['diff', '--no-relative', '--name-status', '-z', '--find-renames', baseSha, headSha, '--'])).split('\0').filter(Boolean), changed = new Set(changedPaths);
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++], count = /^[RC]/.test(status) ? 2 : 1;
    for (let part = 0; part < count; part++) changed.add(relative(tokens[index++]));
  }
  const oldGraph = buildGraph(base, reasons), graph = base === head ? oldGraph : buildGraph(head, reasons), changedFiles = sorted(changed);
  for (const file of changedFiles) {
    if (lockFile(file)) reasons.add(`lock-change:${file}`);
    else if (manifestFile(file)) reasons.add(`package-change:${file}`);
    else if (file.startsWith('.github/') || file.startsWith('.gitlab/')) reasons.add(`ci-change:${file}`);
    else if (/(?:^|\/)(?:[^/]*[.-]config(?:[.-]|$)|\.[^/]*rc(?:[.-]|$))/.test(file)) reasons.add(`config-change:${file}`);
    else if (!javascript(file)) reasons.add(`unknown-file-or-config:${file}`);
    if (oldGraph.publicEntries.has(file) || graph.publicEntries.has(file)) reasons.add(`public-api-change:${file}`);
  }
  const reverse = new Map();
  for (const { edges } of [oldGraph, graph]) for (const [file, deps] of edges) for (const dep of deps) {
    if (!reverse.has(dep)) reverse.set(dep, new Set()); reverse.get(dep).add(file);
  }
  const affected = new Set(changedFiles), queue = [...changedFiles];
  for (let index = 0; index < queue.length; index++) for (const dependent of reverse.get(queue[index]) || []) if (!affected.has(dependent)) { affected.add(dependent); queue.push(dependent); }
  const allFiles = head.entries.map(entry => entry.file), fallback = reasons.size > 0;
  const dependencyEntries = head.entries.filter(entry => manifestFile(entry.file) || lockFile(entry.file)).map(({ file, oid }) => [file, oid]);
  return { schemaVersion: 1, changedFiles, affectedFiles: fallback ? allFiles : sorted(affected),
    testFiles: allFiles.filter(file => testFile(file) && (fallback || affected.has(file))), fallback, reasons: sorted(reasons),
    sourceHash: hash(head.entries.map(({ file, mode, oid }) => [file, mode, oid])),
    dependencyHash: hash({ manifests: dependencyEntries, edges: [...graph.edges].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) }) };
}
