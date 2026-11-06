import { createHash } from 'node:crypto';

const limits = { files: 20000, modules: 256, edges: 100000, findings: 10000 };
const digest = /^[a-f0-9]{64}$/;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const isDigest = value => typeof value === 'string' && digest.test(value);
const isSha = value => typeof value === 'string' && sha.test(value);
const sorted = values => [...values].sort();
const canonical = value =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, canonical(value[key])]),
        )
      : value;
const hash = value =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const within = (file, root) => file === root || file.startsWith(root + '/');
function fail(code = 'configuration') {
  const error = new Error(
    'Invalid architecture ' +
      (code === 'scope_limit' ? 'scope limit' : code === 'unsafe_path' ? 'path' : 'configuration'),
  );
  error.code = code;
  throw error;
}
function record(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      key =>
        typeof key !== 'string' ||
        !Object.getOwnPropertyDescriptor(value, key).enumerable ||
        !('value' in Object.getOwnPropertyDescriptor(value, key)),
    )
  )
    fail();
  return value;
}
function shape(value, keys) {
  record(value);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function array(value, max, min = 0) {
  if (!Array.isArray(value)) fail();
  if (value.length > max) fail('scope_limit');
  if (value.length < min || Object.keys(value).length !== value.length) fail();
  return value;
}
function text(value, max = 2048) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    !value.isWellFormed() ||
    value !== value.normalize('NFC') ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail();
  return value;
}
function identifier(value) {
  text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail();
  return value;
}
function relative(value) {
  text(value);
  if (
    /[\\:*?{}\[\]<>|%#]/.test(value) ||
    value
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
    fail('unsafe_path');
  return value;
}
function set(value, check, max = limits.files, min = 0) {
  const result = array(value, max, min).map(check);
  if (new Set(result).size !== result.length) fail();
  return sorted(result);
}
function disjoint(paths) {
  const ordered = sorted(paths);
  // The lexically adjacent predecessor need not be an ancestor (a, a-b, a/b).
  const seen = new Set();
  for (const file of ordered) {
    const parts = file.split('/');
    let prefix = '';
    for (const part of parts) {
      prefix += (prefix ? '/' : '') + part;
      if (seen.has(prefix)) fail();
    }
    seen.add(file);
  }
}
function debt(value) {
  return array(value, limits.findings).map(entry => {
    shape(entry, ['findingId', 'owner', 'reason', 'reviewAfter']);
    if (!isDigest(entry.findingId)) fail();
    text(entry.owner, 256);
    text(entry.reason, 4096);
    if (
      typeof entry.reviewAfter !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.reviewAfter)
    )
      fail();
    const date = new Date(entry.reviewAfter);
    const normalizedTime = entry.reviewAfter.includes('.')
      ? entry.reviewAfter
      : entry.reviewAfter.replace('Z', '.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalizedTime) fail();
    return { findingId: entry.findingId, owner: entry.owner, reason: entry.reason, reviewAfter: entry.reviewAfter };
  });
}

/** Pure, strict policy normalization. No filesystem discovery or implicit presets. */
export function validateArchitecturePolicy(value) {
  shape(value, [
    'schemaVersion',
    'version',
    'productRoots',
    'modules',
    'layers',
    'forbiddenImports',
    'cycles',
    'contracts',
    'baseline',
    'exceptions',
    'protectedPaths',
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.cycles !== 'forbid'
  )
    fail();
  const productRoots = set(value.productRoots, relative, limits.modules, 1);
  disjoint(productRoots);
  const layersInput = record(value.layers),
    layerIds = Object.keys(layersInput).sort();
  if (layerIds.length > limits.modules) fail('scope_limit');
  const layers = Object.fromEntries(
    layerIds.map(id => [identifier(id), set(layersInput[id], identifier, limits.modules)]),
  );
  for (const id of layerIds) for (const target of layers[id]) if (!Object.hasOwn(layers, target)) fail();
  const modules = array(value.modules, limits.modules)
    .map(module => {
      shape(module, ['id', 'roots', 'layer', 'public', 'allow']);
      const id = identifier(module.id),
        layer = identifier(module.layer);
      if (!Object.hasOwn(layers, layer)) fail();
      const roots = set(module.roots, relative, limits.modules, 1);
      for (const root of roots) if (!productRoots.some(productRoot => within(root, productRoot))) fail();
      const entries = set(module.public, relative);
      for (const file of entries)
        if (!/\.(?:mjs|js)$/.test(file) || !roots.some(root => file !== root && within(file, root))) fail();
      return { id, roots, layer, public: entries, allow: set(module.allow, identifier, limits.modules) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(modules.map(module => module.id));
  if (ids.size !== modules.length) fail();
  const roots = modules.flatMap(module => module.roots);
  if (roots.length > limits.files) fail('scope_limit');
  disjoint(roots);
  for (const module of modules) for (const target of module.allow) if (!ids.has(target)) fail();
  const forbiddenImports = array(value.forbiddenImports, limits.edges)
    .map(rule => {
      shape(rule, ['from', 'to']);
      identifier(rule.from);
      identifier(rule.to);
      if (!ids.has(rule.from) || !ids.has(rule.to)) fail();
      return { from: rule.from, to: rule.to };
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  if (new Set(forbiddenImports.map(rule => JSON.stringify([rule.from, rule.to]))).size !== forbiddenImports.length)
    fail();
  const contracts = relative(value.contracts),
    protectedPaths = set(value.protectedPaths, relative);
  const baseline = debt(value.baseline),
    exceptions = debt(value.exceptions);
  if (baseline.length + exceptions.length > limits.findings) fail('scope_limit');
  return {
    schemaVersion: 1,
    version: value.version,
    productRoots,
    modules,
    layers,
    forbiddenImports,
    cycles: 'forbid',
    contracts,
    baseline,
    exceptions,
    protectedPaths,
  };
}

function inspectGraph(graph) {
  shape(graph, [
    'schemaVersion',
    'headSha',
    'sourceHash',
    'policyHash',
    'productRoots',
    'files',
    'modules',
    'nodes',
    'edges',
    'unsupported',
  ]);
  if (graph.schemaVersion !== 1 || !isSha(graph.headSha) || !isDigest(graph.sourceHash) || !isDigest(graph.policyHash))
    fail();
  set(graph.productRoots, relative, limits.modules, 1);
  array(graph.modules, limits.modules);
  array(graph.files, limits.files);
  array(graph.nodes, limits.files + limits.edges);
  array(graph.edges, limits.edges);
  array(graph.unsupported, limits.edges);
  const files = new Set();
  for (const file of graph.files) {
    shape(file, ['path', 'mode', 'oid']);
    relative(file.path);
    if (files.has(file.path) || !isSha(file.oid) || !['100644', '100755', '120000', '160000'].includes(file.mode))
      fail();
    files.add(file.path);
  }
  const nodes = new Map();
  let productCount = 0;
  for (const node of graph.nodes) {
    shape(node, ['id', 'kind', 'path', 'module', 'layer', 'sourceHash', 'exports', 'public']);
    text(node.id, 4096);
    if (nodes.has(node.id) || typeof node.public !== 'boolean') fail();
    set(node.exports, name => text(name), limits.files);
    if (node.kind === 'file') {
      if (++productCount > limits.files) fail('scope_limit');
      relative(node.path);
      if (
        node.id !== 'file:' + node.path ||
        !isDigest(node.sourceHash) ||
        !files.has(node.path) ||
        (node.module !== null && typeof node.module !== 'string') ||
        (node.layer !== null && typeof node.layer !== 'string')
      )
        fail();
    } else if (
      !['external', 'builtin'].includes(node.kind) ||
      !node.id.startsWith(node.kind + ':') ||
      node.path !== null ||
      node.module !== null ||
      node.layer !== null ||
      node.sourceHash !== null ||
      node.public ||
      node.exports.length
    )
      fail();
    nodes.set(node.id, node);
  }
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    shape(edge, ['id', 'from', 'to', 'kind', 'specifier', 'offset']);
    if (
      !isDigest(edge.id) ||
      edgeIds.has(edge.id) ||
      nodes.get(edge.from)?.kind !== 'file' ||
      (edge.to !== null && !nodes.has(edge.to)) ||
      !['import', 'reexport', 'dynamic-import', 'require', 'require-resolve'].includes(edge.kind) ||
      !Number.isSafeInteger(edge.offset) ||
      edge.offset < 0
    )
      fail();
    text(edge.specifier);
    edgeIds.add(edge.id);
  }
  return nodes;
}

/** Base rules only; graph construction, contracts and debt remain separate ports. */
export function evaluateArchitecture(input) {
  shape(input, ['policy', 'graph']);
  const { policy, graph } = input;
  const normalized = validateArchitecturePolicy(policy),
    nodes = inspectGraph(graph);
  if (
    graph.policyHash !== hash(normalized) ||
    JSON.stringify(sorted(graph.productRoots)) !== JSON.stringify(normalized.productRoots)
  )
    fail();
  const modules = new Map(normalized.modules.map(module => [module.id, module]));
  const ownership = new Map(),
    findings = new Map();
  function add(ruleId, file, offset, fromModule, toModule, relatedFiles, participants) {
    const sourceHashes = sorted(new Set(participants)).map(file => ({
      file,
      sha256: nodes.get('file:' + file).sourceHash,
    }));
    const body = {
      ruleId,
      severity: 'error',
      file,
      offset,
      fromModule,
      toModule,
      relatedFiles: sorted(new Set(relatedFiles)),
      sourceHashes,
    };
    const id = hash(body);
    findings.set(id, { id, ...body });
    if (findings.size > limits.findings) fail('scope_limit');
  }
  for (const node of nodes.values()) {
    if (node.kind !== 'file') continue;
    if (!normalized.productRoots.some(root => within(node.path, root))) fail();
    const owners = normalized.modules.filter(module => module.roots.some(root => within(node.path, root)));
    ownership.set(node.id, owners.length === 1 ? owners[0].id : null);
    if (owners.length !== 1)
      add(owners.length ? 'ownership.overlap' : 'ownership.unowned', node.path, null, null, null, [], [node.path]);
  }
  const forbidden = new Set(normalized.forbiddenImports.map(rule => JSON.stringify([rule.from, rule.to])));
  const adjacency = new Map(normalized.modules.map(module => [module.id, new Set()]));
  const crossEdges = [];
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (to?.kind !== 'file') continue;
    const fromId = ownership.get(edge.from),
      toId = ownership.get(edge.to);
    if (!fromId || !toId || fromId === toId) continue;
    const fromModule = modules.get(fromId),
      toModule = modules.get(toId);
    const emit = ruleId => add(ruleId, from.path, edge.offset, fromId, toId, [to.path], [from.path, to.path]);
    if (forbidden.has(JSON.stringify([fromId, toId]))) emit('dependency.forbidden');
    if (!fromModule.allow.includes(toId)) emit('dependency.not-allowed');
    if (!normalized.layers[fromModule.layer].includes(toModule.layer)) emit('layer.direction');
    if (!toModule.public.includes(to.path)) emit('entry.private');
    adjacency.get(fromId).add(toId);
    crossEdges.push({ fromId, toId, from: from.path, to: to.path });
  }
  // Tarjan runs over at most 256 modules, never recursively over product files.
  let index = 0;
  const indices = new Map(),
    low = new Map(),
    stack = [],
    active = new Set();
  function connect(id) {
    indices.set(id, index);
    low.set(id, index++);
    stack.push(id);
    active.add(id);
    for (const target of sorted(adjacency.get(id))) {
      if (!indices.has(target)) {
        connect(target);
        low.set(id, Math.min(low.get(id), low.get(target)));
      } else if (active.has(target)) low.set(id, Math.min(low.get(id), indices.get(target)));
    }
    if (low.get(id) !== indices.get(id)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== id);
    if (component.length < 2) return;
    const members = new Set(component),
      paths = new Set();
    for (const edge of crossEdges)
      if (members.has(edge.fromId) && members.has(edge.toId)) {
        paths.add(edge.from);
        paths.add(edge.to);
      }
    add('dependency.cycle', null, null, null, null, [...paths], [...paths]);
  }
  for (const id of modules.keys()) if (!indices.has(id)) connect(id);
  return {
    schemaVersion: 1,
    findings: [...findings.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
