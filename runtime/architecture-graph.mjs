import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { gitBoundary } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { noLinks } from './toolchains.mjs';
import { inspectJavaScriptModule } from './javascript-dependencies.mjs';

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
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  throw failure('configuration');
}
const hash = value => digest(JSON.stringify(canonical(value)));
const failure = code => Object.assign(new Error(`Architecture graph: ${code}`), { code });
const within = (file, root) => file === root || file.startsWith(root + '/');
const javascript = file => /\.(?:mjs|js)$/.test(file);
const executable = file =>
  /\.(?:cjs|ts|tsx|mts|cts|jsx|vue|svelte|py|pyi|go|rs|cs|vb|fs|fsx|java|class|jar|kt|kts|rb|php|ps1|psm1|sh|bash|bat|cmd|vbs|c|h|cpp|cc|hpp|swift|scala|ex|exs|clj|lua|dart|wasm|node|dll|exe|so|dylib|coffee|pl|r|jl|erl|hs|elm|zig|nim|sql)$/i.test(
    file,
  );
function safePath(file) {
  if (
    typeof file !== 'string' ||
    !file ||
    file.length > 2048 ||
    file.normalize('NFC') !== file ||
    /[\\:\x00-\x1f\x7f*?\[\]{}]/.test(file) ||
    file.startsWith('/') ||
    file
      .split('/')
      .some(
        part =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw failure('unsafe_path');
  return file;
}
function utf8(bytes) {
  const source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) throw failure('configuration');
  return source;
}

// Binary Git output is essential: decoding/re-encoding cat-file corrupts sizes
// and hashes for non-ASCII or invalid UTF-8. No filters, source imports or hooks.
function git(project, args, input, maxBytes = 8 * 1024 ** 2) {
  const boundary = gitBoundary(args, workerEnvironment());
  boundary.env.GIT_NO_REPLACE_OBJECTS = '1';
  boundary.env.GIT_NO_LAZY_FETCH = '1';
  return new Promise((resolve, reject) => {
    const child = spawn('git', boundary.args, {
      cwd: project,
      env: boundary.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let size = 0,
      errorSize = 0,
      stopped;
    const stop = code => {
      stopped ||= code;
      child.kill();
    };
    const timer = setTimeout(() => stop('timeout'), 30000);
    timer.unref();
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > maxBytes) stop('scope_limit');
      else chunks.push(bytes);
    });
    child.stderr.on('data', bytes => {
      errorSize += bytes.length;
      if (errorSize > 65536) stop('scope_limit');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(failure('configuration'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (stopped || code !== 0) reject(failure(stopped || 'configuration'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function snapshot(project, headSha) {
  const resolved = utf8(await git(project, ['rev-parse', '--verify', `${headSha}^{commit}`])).trim();
  if (resolved !== headSha) throw failure('configuration');
  const rows = utf8(await git(project, ['ls-tree', '-rz', '--full-tree', headSha]))
    .split('\0')
    .filter(Boolean);
  if (rows.length > 20000) throw failure('scope_limit');
  const entries = rows
    .map(row => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      if (!match || match[3].length !== headSha.length) throw failure('configuration');
      return { path: safePath(match[4]), mode: match[1], oid: match[3], type: match[2] };
    })
    .sort((a, b) => compare(a.path, b.path));
  const aliases = new Set();
  for (const entry of entries) {
    // Cross-platform ambiguous case aliases cannot be a portable graph.
    const alias = entry.path.toLowerCase();
    if (aliases.has(alias)) throw failure('unsafe_path');
    aliases.add(alias);
  }
  // Inventory-only files also need real objects. A missing documentation/data
  // blob is an incomplete snapshot even though it is never parsed as product JS.
  const blobs = entries.filter(entry => entry.type === 'blob');
  if (blobs.length) {
    const checked = utf8(
      await git(project, ['cat-file', '--batch-check'], blobs.map(entry => entry.oid).join('\n') + '\n'),
    )
      .trimEnd()
      .split('\n');
    if (
      checked.length !== blobs.length ||
      checked.some((row, index) => {
        const match = /^([a-f0-9]+) blob (\d+)$/.exec(row);
        return !match || match[1] !== blobs[index].oid || !Number.isSafeInteger(Number(match[2]));
      })
    )
      throw failure('configuration');
  }
  return entries;
}
async function sources(project, entries) {
  if (!entries.length) return new Map();
  const request = entries.map(entry => entry.oid).join('\n') + '\n';
  const checks = utf8(await git(project, ['cat-file', '--batch-check'], request))
    .trimEnd()
    .split('\n');
  if (checks.length !== entries.length) throw failure('configuration');
  let total = 0;
  const sizes = checks.map((row, index) => {
    const [oid, type, length] = row.split(' '),
      size = Number(length);
    if (oid !== entries[index].oid || type !== 'blob' || !/^\d+$/.test(length) || !Number.isSafeInteger(size))
      throw failure('configuration');
    total += size;
    if (size > 16 * 1024 ** 2 || total > 128 * 1024 ** 2) throw failure('scope_limit');
    return size;
  });
  const bytes = await git(project, ['cat-file', '--batch'], request, total + entries.length * 128);
  const result = new Map();
  let offset = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index],
      size = sizes[index],
      end = bytes.indexOf(10, offset);
    if (
      end < 0 ||
      bytes.subarray(offset, end).toString('ascii') !== `${entry.oid} blob ${size}` ||
      end + size + 1 >= bytes.length ||
      bytes[end + size + 1] !== 10
    )
      throw failure('configuration');
    const content = bytes.subarray(end + 1, end + 1 + size);
    const actual = createHash(entry.oid.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${size}\0`)
      .update(content)
      .digest('hex');
    if (actual !== entry.oid) throw failure('configuration');
    result.set(entry.path, content);
    offset = end + size + 2;
  }
  if (offset !== bytes.length) throw failure('configuration');
  return result;
}

/** An immutable graph, independent of checkout HEAD/cleanliness (the runner owns that fence). */
// oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function readArchitectureGraph({ project, headSha, policy }) {
  if (typeof project !== 'string' || !project || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headSha || ''))
    throw failure('arguments');
  try {
    await noLinks(path.resolve(project));
    project = await realpath(path.resolve(project));
  } catch {
    throw failure('unsafe_path');
  }
  const root = path.resolve(utf8(await git(project, ['rev-parse', '--show-toplevel'])).trim());
  try {
    await noLinks(root);
    if ((await realpath(root)) !== project) throw failure('unsafe_path');
  } catch {
    throw failure('unsafe_path');
  }
  // B owns policy normalization; defensively guard all paths before using it.
  policy = canonical(policy);
  if (
    policy.schemaVersion !== 1 ||
    !Array.isArray(policy.productRoots) ||
    !policy.productRoots.length ||
    !Array.isArray(policy.modules)
  )
    throw failure('configuration');
  if (policy.modules.length > 256) throw failure('scope_limit');
  for (const file of [
    ...policy.productRoots,
    policy.contracts,
    ...policy.protectedPaths,
    ...policy.modules.flatMap(module => [...module.roots, ...module.public]),
  ])
    safePath(file);
  const product = file => policy.productRoots.some(root => within(file, root));
  const entries = await snapshot(project, headSha),
    files = entries.map(({ path, mode, oid }) => ({ path, mode, oid }));
  const regular = entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode);
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const contents = await sources(
    project,
    entries.filter(
      entry =>
        regular(entry) &&
        (entry.path === 'package.json' ||
          entry.path.endsWith('/package.json') ||
          (product(entry.path) && javascript(entry.path))),
    ),
  );
  const unsupported = new Map();
  const unknown = (scope, file, reason, offset = null) => {
    const id = hash([scope, file, reason, offset]);
    unsupported.set(id, { id, scope, file, reason, offset });
    if (unsupported.size > 10000) throw failure('scope_limit');
  };
  for (const entry of entries) if (!regular(entry)) unknown('tree', entry.path, 'unsupported-tree-entry');
  const packages = [],
    names = new Map();
  for (const [file, bytes] of contents) {
    if (file !== 'package.json' && !file.endsWith('/package.json')) continue;
    let data;
    try {
      data = JSON.parse(utf8(bytes));
      if (!data || Array.isArray(data) || typeof data !== 'object') throw failure('configuration');
    } catch {
      data = null;
    }
    const pkg = { root: path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file), file, data };
    packages.push(pkg);
    if (typeof data?.name === 'string') {
      const list = names.get(data.name) || [];
      list.push(pkg);
      names.set(data.name, list);
    }
  }
  packages.sort((a, b) => b.root.length - a.root.length || compare(a.root, b.root));
  const owner = file => packages.find(pkg => !pkg.root || within(file, pkg.root));
  const nodes = new Map(),
    inspections = new Map();
  for (const entry of entries) {
    const file = entry.path;
    if (!product(file) || !regular(entry)) continue;
    if (
      executable(file) ||
      (/\.(?:mjs|js)$/i.test(file) && !javascript(file)) ||
      (entry.mode === '100755' && !javascript(file) && !file.endsWith('.json'))
    ) {
      unknown('language', file, 'unsupported-language');
      continue;
    }
    if (!javascript(file)) continue;
    const pkg = owner(file);
    if (pkg && !pkg.data) unknown('dependency', pkg.file, 'unsupported-package');
    const esm = file.endsWith('.mjs') || pkg?.data?.type === 'module';
    if (!esm) unknown('language', file, 'unsupported-language');
    const bytes = contents.get(file);
    let inspection;
    try {
      inspection = esm
        ? inspectJavaScriptModule({ file, source: utf8(bytes) })
        : { exports: [], dependencies: [], unsupported: [] };
    } catch {
      unknown('dependency', file, 'parse-error', 0);
      inspection = { exports: [], dependencies: [], unsupported: [] };
    }
    const owners = policy.modules.filter(module => module.roots.some(root => within(file, root))),
      module = owners.length === 1 ? owners[0] : null;
    const publicEntry = policy.modules.some(module => module.public.includes(file));
    nodes.set(`file:${file}`, {
      id: `file:${file}`,
      kind: 'file',
      path: file,
      module: module?.id ?? null,
      layer: module?.layer ?? null,
      sourceHash: digest(bytes),
      exports: inspection.exports,
      public: publicEntry,
    });
    inspections.set(file, inspection);
    for (const item of inspection.unsupported) {
      // Export uncertainty matters at declared APIs; dependency uncertainty always blocks.
      if (item.scope !== 'exports' || publicEntry) unknown(item.scope, file, item.reason, item.offset);
      if (item.reason === 'commonjs-exports') unknown('language', file, 'unsupported-language');
    }
  }
  function local(candidate, file, offset) {
    try {
      safePath(candidate);
    } catch {
      unknown('dependency', file, 'unsafe-path', offset);
      return null;
    }
    const candidates = byPath.has(candidate)
      ? [candidate]
      : [
          candidate + '.js',
          candidate + '.mjs',
          candidate + '.cjs',
          candidate + '/index.js',
          candidate + '/index.mjs',
          candidate + '/index.cjs',
        ].filter(name => byPath.has(name));
    if (candidates.length > 1) {
      unknown('dependency', file, 'ambiguous-import', offset);
      return null;
    }
    const target = candidates[0];
    if (!target) {
      unknown('dependency', file, 'unresolved-import', offset);
      return null;
    }
    if (!regular(byPath.get(target))) {
      unknown('dependency', file, 'unsafe-path', offset);
      return null;
    }
    if (!product(target)) {
      unknown('dependency', file, 'out-of-product-import', offset);
      return null;
    }
    if (!nodes.has(`file:${target}`) || unsupported.has(hash(['language', target, 'unsupported-language', null]))) {
      unknown('dependency', file, 'unsupported-language', offset);
      return null;
    }
    return `file:${target}`;
  }
  function resolve(specifier, file, offset) {
    if (isBuiltin(specifier)) return `builtin:${specifier.replace(/^node:/, '')}`;
    if (/[\\%?#:\x00-\x1f\x7f*]/.test(specifier) || specifier.startsWith('/')) {
      unknown('dependency', file, specifier.startsWith('#') ? 'unsupported-package' : 'unsafe-path', offset);
      return null;
    }
    if (specifier.startsWith('.'))
      return local(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)), file, offset);
    if (
      !/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9_~][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/.test(specifier) ||
      specifier.split('/').some(part => part === '.' || part === '..')
    ) {
      unknown('dependency', file, 'unsupported-package', offset);
      return null;
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0],
      matches = names.get(name) || [];
    if (matches.length > 1) {
      unknown('dependency', file, 'ambiguous-import', offset);
      return null;
    }
    if (matches.length) {
      const pkg = matches[0],
        suffix = specifier.slice(name.length),
        exports = pkg.data.exports;
      let target;
      if (exports !== undefined)
        target =
          typeof exports === 'string' && !suffix
            ? exports
            : exports && typeof exports === 'object' && !Array.isArray(exports)
              ? exports[suffix ? `.${suffix}` : '.']
              : undefined;
      else target = suffix ? '.' + suffix : pkg.data.main || './index.js';
      if (
        typeof target !== 'string' ||
        !target.startsWith('./') ||
        /[\\%?#:\x00-\x1f\x7f*]/.test(target) ||
        target
          .split('/')
          .slice(1)
          .some(part => !part || part === '.' || part === '..')
      ) {
        unknown('dependency', file, 'unsupported-package', offset);
        return null;
      }
      return local(path.posix.join(pkg.root, target), file, offset);
    }
    const data = owner(file)?.data;
    const declarations = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .map(key => data?.[key])
      .filter(map => map && typeof map === 'object' && Object.hasOwn(map, name));
    if (declarations.length) {
      if (declarations.every(map => !Array.isArray(map) && typeof map[name] === 'string' && map[name].trim()))
        return `external:${specifier}`;
      unknown('dependency', file, 'unsupported-package', offset);
      return null;
    }
    unknown('dependency', file, 'unresolved-import', offset);
    return null;
  }
  const edges = [];
  for (const [file, inspection] of inspections)
    for (const dependency of inspection.dependencies) {
      const { kind, specifier, offset } = dependency,
        from = `file:${file}`,
        to = resolve(specifier, file, offset);
      if (kind === 'require' || kind === 'require-resolve') unknown('language', file, 'unsupported-language');
      if (to && !nodes.has(to)) {
        const kind = to.startsWith('builtin:') ? 'builtin' : 'external';
        nodes.set(to, {
          id: to,
          kind,
          path: null,
          module: null,
          layer: null,
          sourceHash: null,
          exports: [],
          public: false,
        });
      }
      edges.push({ id: hash([from, to, kind, specifier, offset]), from, to, kind, specifier, offset });
      if (edges.length > 100000) throw failure('scope_limit');
    }
  return {
    schemaVersion: 1,
    headSha,
    sourceHash: hash(files),
    policyHash: hash(policy),
    productRoots: policy.productRoots,
    files,
    modules: policy.modules,
    nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)),
    edges: edges.sort((a, b) => compare(a.from, b.from) || a.offset - b.offset || compare(a.id, b.id)),
    unsupported: [...unsupported.values()].sort(
      (a, b) => compare(a.file ?? '', b.file ?? '') || (a.offset ?? -1) - (b.offset ?? -1) || compare(a.id, b.id),
    ),
  };
}
