import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const regular = mode => mode === '100644' || mode === '100755';
const testPath = file => /\.test\.(?:mjs|js)$/.test(file);
const javascript = file => /\.(?:mjs|js)$/.test(file);
const sorted = values => [...new Set(values)].sort();
const equal = (a, b) => canonical(a) === canonical(b);
function fail(code = 'configuration') {
  throw Object.assign(new Error('Invalid contract registry input'), { code });
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function record(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    !equal(Object.keys(value).sort(), [...keys].sort())
  )
    fail();
}
function list(value, limit = 20000) {
  if (!Array.isArray(value)) fail();
  if (value.length > limit) fail('scope_limit');
  return value;
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.normalize('NFC') || /[\x00-\x1f\x7f]/.test(value))
    fail();
  return value;
}
function relative(value) {
  text(value);
  if (
    /[\\:*?"<>|\[\]{}]/.test(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))
  )
    fail();
  return value;
}
function strings(value, validate = text, ordered = false) {
  list(value);
  value.forEach(validate);
  const result = sorted(value);
  if (result.length !== value.length || (ordered && !equal(result, value))) fail();
  return result;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
}
function exportName(value) {
  if (typeof value !== 'string') fail();
}

// This port consumes immutable graph records. It never reads source, executes a
// declared test, or treats a caller's shapeHash as semantic compatibility proof.
function registry(value) {
  if (value === null) return null;
  record(value, ['schemaVersion', 'contracts', 'migrations']);
  if (value.schemaVersion !== 1) fail();
  const contracts = list(value.contracts, 256).map(row => {
    record(row, ['id', 'module', 'version', 'entry', 'exports', 'shapeHash', 'tests']);
    if (typeof row.shapeHash !== 'string' || !HASH.test(row.shapeHash)) fail();
    return {
      id: text(row.id),
      module: text(row.module),
      version: version(row.version),
      entry: relative(row.entry),
      exports: strings(row.exports, exportName, true),
      shapeHash: row.shapeHash,
      tests: strings(row.tests, relative),
    };
  });
  if (new Set(contracts.map(row => row.id)).size !== contracts.length) fail();
  const migrations = list(value.migrations, 10000).map(row => {
    record(row, ['contractId', 'fromVersion', 'toVersion', 'plan', 'consumers', 'tests']);
    const tests = list(row.tests, 256)
      .map(mapping => {
        record(mapping, ['module', 'files']);
        return { module: text(mapping.module), files: strings(mapping.files, relative) };
      })
      .sort((a, b) => compare(a.module, b.module));
    if (new Set(tests.map(row => row.module)).size !== tests.length) fail();
    return {
      contractId: text(row.contractId),
      fromVersion: version(row.fromVersion),
      toVersion: row.toVersion === null ? null : version(row.toVersion),
      plan: relative(row.plan),
      consumers: strings(row.consumers),
      tests,
    };
  });
  return { schemaVersion: 1, contracts: contracts.sort((a, b) => compare(a.id, b.id)), migrations };
}
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function graph(value, enrolled) {
  if (value === null && !enrolled) return { files: [], modules: [], nodes: [], edges: [], unsupported: [] };
  if (!value || value.schemaVersion !== 1) fail();
  list(value.files, 20000);
  list(value.modules, 256);
  list(value.nodes, 120000);
  list(value.edges, 100000);
  list(value.unsupported, 10000);
  const nodes = value.nodes.filter(row => row.kind === 'file');
  for (const row of nodes) {
    relative(row.path);
    strings(row.exports, exportName, true);
    if (!HASH.test(row.sourceHash)) fail();
  }
  for (const row of value.files) relative(row.path);
  for (const row of value.modules) {
    text(row.id);
    strings(row.public, relative);
  }
  return value;
}

function reverseModules(graphs) {
  const reverse = new Map();
  for (const graph of graphs) {
    const nodes = new Map(graph.nodes.map(row => [row.id, row]));
    for (const edge of graph.edges) {
      const from = nodes.get(edge.from)?.module,
        to = nodes.get(edge.to)?.module;
      if (!from || !to || from === to) continue;
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to).add(from);
    }
  }
  return module => {
    const visited = new Set([module]),
      queue = [module];
    for (let index = 0; index < queue.length; index++)
      for (const next of reverse.get(queue[index]) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    visited.delete(module);
    return [...visited].sort();
  };
}

export class ContractRegistry {
  plan(input) {
    record(input, ['base', 'head', 'baseGraph', 'headGraph', 'changedPaths']);
    const { base, head, baseGraph, headGraph, changedPaths } = input;
    const before = registry(base),
      after = registry(head);
    const oldGraph = graph(baseGraph, before !== null),
      newGraph = graph(headGraph, after !== null);
    const changed = new Set(strings(changedPaths, relative));
    const oldContracts = new Map((before?.contracts ?? []).map(row => [row.id, row]));
    const newContracts = new Map((after?.contracts ?? []).map(row => [row.id, row]));
    const nodes = new Map(
      [...oldGraph.nodes, ...newGraph.nodes].filter(row => row.kind === 'file').map(row => [row.path, row]),
    );
    const inventories = new Map(
      [oldGraph, newGraph].map(graph => [graph, new Map(graph.files.map(row => [row.path, row.mode]))]),
    );
    const moduleFiles = new Map();
    for (const row of nodes.values()) {
      if (!moduleFiles.has(row.module)) moduleFiles.set(row.module, []);
      moduleFiles.get(row.module).push(row.path);
    }
    const findings = new Map(),
      requiredTests = new Map(),
      requiredConsumers = new Set(),
      changes = [];
    const consumersOf = reverseModules([oldGraph, newGraph]);
    const oldSources = new Map(
      oldGraph.nodes.filter(row => row.kind === 'file').map(row => [row.path, row.sourceHash]),
    );
    const newSources = new Map(
      newGraph.nodes.filter(row => row.kind === 'file').map(row => [row.path, row.sourceHash]),
    );
    const changedModules = new Set(
      [...oldGraph.nodes, ...newGraph.nodes]
        .filter(
          row =>
            row.kind === 'file' &&
            javascript(row.path) &&
            changed.has(row.path) &&
            oldSources.get(row.path) !== newSources.get(row.path),
        )
        .map(row => row.module)
        .filter(Boolean),
    );
    const filesOf = module => moduleFiles.get(module) ?? [];
    const finding = (
      ruleId,
      contract,
      { file = contract?.entry ?? null, toModule = null, relatedFiles = [], participants = [] } = {},
    ) => {
      const entries = [oldContracts.get(contract?.id)?.entry, newContracts.get(contract?.id)?.entry];
      const body = {
        ruleId,
        severity: 'error',
        file,
        offset: null,
        fromModule: contract?.module ?? null,
        toModule,
        relatedFiles: sorted(relatedFiles),
        sourceHashes: sorted([file, ...entries, ...relatedFiles, ...participants].filter(path => nodes.has(path))).map(
          file => ({ file, sha256: nodes.get(file).sourceHash }),
        ),
      };
      const id = digest(body);
      findings.set(id, { id, ...body });
      if (findings.size > 10000) fail('scope_limit');
    };
    const addTest = (file, contractId, module) => {
      if (!requiredTests.has(file)) requiredTests.set(file, { contracts: new Set(), modules: new Set() });
      requiredTests.get(file).contracts.add(contractId);
      requiredTests.get(file).modules.add(module);
      if (requiredTests.size > 20000) fail('scope_limit');
    };
    const checkTests = (files, contract, graph, module = contract.module, select = false) => {
      const inventory = inventories.get(graph);
      if (!files.length)
        finding('contract.tests', contract, {
          toModule: module === contract.module ? null : module,
          participants: filesOf(module),
        });
      for (const file of files) {
        if (!testPath(file) || !regular(inventory.get(file)))
          finding('contract.tests', contract, {
            toModule: module === contract.module ? null : module,
            relatedFiles: [file],
            participants: filesOf(module),
          });
        else if (select) addTest(file, contract.id, module);
      }
    };
    const selectContract = contract => checkTests(contract.tests, contract, newGraph, contract.module, true);

    const validateSnapshot = (data, graph) => {
      const entries = new Map();
      for (const module of graph.modules) for (const entry of module.public) entries.set(entry, module.id);
      const byEntry = new Map();
      for (const contract of data?.contracts ?? []) {
        if (!byEntry.has(contract.entry)) byEntry.set(contract.entry, []);
        byEntry.get(contract.entry).push(contract);
        const node = graph.nodes.find(row => row.kind === 'file' && row.path === contract.entry);
        if (
          entries.get(contract.entry) !== contract.module ||
          !node ||
          node.module !== contract.module ||
          !node.public ||
          !equal(node.exports, contract.exports) ||
          graph.unsupported.some(row => row.scope === 'exports' && row.file === contract.entry)
        )
          finding('contract.exports', contract);
        checkTests(contract.tests, contract, graph);
      }
      for (const [entry, module] of entries)
        if (byEntry.get(entry)?.length !== 1) finding('contract.exports', { entry, module });
      const history = new Map();
      for (const row of data?.migrations ?? []) {
        const contract = (data?.contracts ?? []).find(contract => contract.id === row.contractId) ??
          oldContracts.get(row.contractId) ?? { id: row.contractId, entry: null, module: null };
        const previous = history.get(row.contractId);
        if (
          (row.toVersion !== null && row.toVersion <= row.fromVersion) ||
          (previous && (previous.toVersion === null || previous.toVersion !== row.fromVersion))
        )
          finding('contract.migration', contract);
        if (!regular(inventories.get(graph).get(row.plan)))
          finding('contract.migration', contract, { relatedFiles: [row.plan] });
        for (const mapping of row.tests) checkTests(mapping.files, contract, graph, mapping.module);
        const mapped = new Set(row.tests.map(mapping => mapping.module));
        for (const consumer of row.consumers)
          if (!mapped.has(consumer))
            finding('contract.tests', contract, { toModule: consumer, participants: filesOf(consumer) });
        if (!row.tests.some(mapping => !row.consumers.includes(mapping.module))) finding('contract.tests', contract);
        history.set(row.contractId, row);
      }
      for (const [id, row] of history) {
        const active = (data?.contracts ?? []).find(contract => contract.id === id);
        if (row.toVersion === null ? Boolean(active) : active?.version !== row.toVersion)
          finding('contract.version', active ?? oldContracts.get(id));
      }
    };
    // An unenrolled historical graph is discovery data, not evidence of old
    // registry compliance. In particular, first adoption needs no old registry.
    if (before) validateSnapshot(before, oldGraph);
    validateSnapshot(after, newGraph);
    if (before && !after) finding('contract.version', null);

    const oldMigrations = before?.migrations ?? [],
      newMigrations = after?.migrations ?? [];
    if (
      oldMigrations.length > newMigrations.length ||
      oldMigrations.some((row, index) => !equal(row, newMigrations[index]))
    )
      finding('contract.migration', null);
    const appended = newMigrations.slice(oldMigrations.length),
      usedMigrations = new Set();
    const retiredIds = new Set(oldMigrations.filter(row => row.toVersion === null).map(row => row.contractId));
    for (const id of sorted([...oldContracts.keys(), ...newContracts.keys()])) {
      const old = oldContracts.get(id),
        current = newContracts.get(id),
        contract = current ?? old;
      const consumers = sorted([...consumersOf(contract.module), ...(old ? consumersOf(old.module) : [])]);
      let kind = null;
      if (!old) {
        kind = 'added';
        if (retiredIds.has(id) || newMigrations.some(row => row.contractId === id && row.toVersion === null))
          finding('contract.version', contract);
      } else if (!current) kind = 'retired';
      else if (
        old.version !== current.version ||
        !equal(
          [old.module, old.entry, old.exports, old.shapeHash],
          [current.module, current.entry, current.exports, current.shapeHash],
        )
      )
        kind = 'breaking';
      if (!kind) continue;
      changes.push({
        contractId: id,
        kind,
        fromVersion: old?.version ?? null,
        toVersion: current?.version ?? null,
        consumers,
      });
      if (current) selectContract(current);
      for (const consumer of consumers) requiredConsumers.add(consumer);
      if (kind === 'added') continue;
      if (current && current.version <= old.version) finding('contract.version', current);
      const matches = appended.filter(
        row => row.contractId === id && row.fromVersion === old.version && row.toVersion === (current?.version ?? null),
      );
      if (matches.length !== 1) finding('contract.migration', contract);
      const migration = matches[0];
      if (migration) {
        usedMigrations.add(migration);
        if (!equal(migration.consumers, consumers))
          finding('contract.dependent', contract, { participants: consumers.flatMap(filesOf) });
        const mappings = new Map(migration.tests.map(row => [row.module, row.files]));
        // The old producer still needs replacement coverage when retired/moved.
        for (const module of sorted([old.module, contract.module, ...consumers]))
          checkTests(mappings.get(module) ?? [], contract, newGraph, module, true);
        for (const module of mappings.keys())
          if (![old.module, contract.module, ...consumers].includes(module))
            finding('contract.migration', contract, { toModule: module });
      }
      for (const consumer of consumers)
        if (!changedModules.has(consumer))
          finding('contract.dependent', contract, { toModule: consumer, relatedFiles: filesOf(consumer) });
    }
    // Newly invented history cannot excuse an unrelated or unchanged interface.
    if (before)
      for (const row of appended)
        if (!usedMigrations.has(row))
          finding('contract.migration', newContracts.get(row.contractId) ?? oldContracts.get(row.contractId));

    for (const module of changedModules) {
      if (![...oldContracts.values(), ...newContracts.values()].some(row => row.module === module)) continue;
      const consumers = consumersOf(module);
      for (const consumer of consumers) requiredConsumers.add(consumer);
      for (const contract of newContracts.values())
        if ([module, ...consumers].includes(contract.module)) selectContract(contract);
    }
    return {
      schemaVersion: 1,
      status: findings.size ? 'blocked' : before === null && after === null ? 'not_applicable' : 'planned',
      changes,
      requiredConsumers: [...requiredConsumers].sort(),
      requiredTests: [...requiredTests]
        .sort(([a], [b]) => compare(a, b))
        .map(([file, row]) => ({ file, forContracts: [...row.contracts].sort(), forModules: [...row.modules].sort() })),
      findings: [...findings.values()].sort((a, b) => compare(a.id, b.id)),
    };
  }
}
