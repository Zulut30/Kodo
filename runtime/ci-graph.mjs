import path from 'node:path';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { parse } from 'acorn';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { noLinks } from './toolchains.mjs';

const sorted = values => [...new Set(values)].sort();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const javascript = file => /\.(?:mjs|cjs|js)$/.test(file);
const unsupported = file => /\.(?:ts|tsx|mts|cts|jsx|vue|svelte|py|pyi|go|rs|cs|vb|fs|fsx|java|kt|rb|php|ps1|sh|bash|c|h|cpp|cc|hpp|swift|scala|ex|exs|clj|lua|dart)$/.test(file);
const testFile = file => /(?:^|\/)(?:[^/]+[._-](?:test|spec)|test-[^/]+)\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/.test(file) || /(?:^|\/)(?:test|__tests__)\/.*\.(?:mjs|cjs|js|ts|tsx|mts|cts|jsx)$/.test(file);
const lockFile = file => /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(file);
const manifestFile = file => /(?:^|\/)package\.json$/.test(file);

function relative(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid affected path');
  return file;
}
async function git(project, args, input) {
  return (await execute('git', args, { cwd: project, input, env: workerEnvironment(), rawOutput: true, timeoutMs: 30000 })).stdout;
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
function staticDependencies(source, file, reasons) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: file.endsWith('.cjs') ? 'script' : 'module', allowHashBang: true }); }
  catch { reasons.add(`parse-error:${file}`); return []; }
  const dependencies = [];
  const add = node => {
    if (node?.type === 'Literal' && typeof node.value === 'string') dependencies.push(node.value);
    else reasons.add(`dynamic-dependency:${file}`);
  };
  function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) add(node.source);
    if (node.type === 'ImportExpression') add(node.source);
    if (node.type === 'CallExpression' && (node.callee?.type === 'Identifier' && node.callee.name === 'require' || node.callee?.type === 'MemberExpression' && node.callee.object?.name === 'require' && node.callee.property?.name === 'resolve')) {
      if (node.arguments.length !== 1) reasons.add(`dynamic-dependency:${file}`); else add(node.arguments[0]);
    }
    // Aliased/custom loaders and eval cannot be modelled by static imports.
    if (node.type === 'Identifier' && ['require', 'createRequire', 'eval', 'Function'].includes(node.name)) {
      const directRequire = node.name === 'require' && (parent?.type === 'CallExpression' && parent.callee === node || parent?.type === 'MemberExpression' && parent.object === node && parent.property?.name === 'resolve');
      if (!directRequire) reasons.add(`dynamic-dependency:${file}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) for (const child of value) walk(child, node);
      else if (value && typeof value === 'object') walk(value, node);
    }
  }
  walk(ast); return sorted(dependencies);
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
  if (path.resolve((await git(project, ['rev-parse', '--show-toplevel'])).trim()) !== project) throw new Error('Affected project must be the repository root');
  if (!Array.isArray(changedPaths)) throw new Error('Invalid changed paths');
  changedPaths.forEach(relative);
  headSha = await revision(project, headSha || (await git(project, ['rev-parse', 'HEAD'])).trim());
  baseSha = await revision(project, baseSha || headSha);
  const head = await snapshot(project, headSha), base = baseSha === headSha ? head : await snapshot(project, baseSha), reasons = new Set();
  const currentHead = (await git(project, ['rev-parse', 'HEAD'])).trim();
  if (currentHead !== headSha) reasons.add('head-mismatch');
  if ((await git(project, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) reasons.add('dirty-worktree');
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
