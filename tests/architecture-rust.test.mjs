import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { validateArchitecturePolicy, evaluateArchitecture } from '../runtime/architecture-policy.mjs';
import { readArchitectureGraph } from '../runtime/architecture-graph.mjs';
import { checkArchitecture, architectureCli } from '../runtime/architecture-cli.mjs';
import { runArchitectureChecks, isCurrentArchitectureReceipt } from '../runtime/architecture-gate.mjs';
import { applyArchitectureDebt } from '../runtime/architecture-debt.mjs';
import { compileBlueprint, lintFactorySpec } from '../runtime/project-blueprint.mjs';
import { projectBlueprintCli } from '../runtime/project-cli-blueprint.mjs';

const rustModule = await import('../runtime/architecture-rust.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/runtime/architecture-rust.mjs')) return {};
  throw error;
});
const parseWorkspace = input => {
  assert.equal(typeof rustModule.parseCargoWorkspace, 'function', 'runtime/architecture-rust.mjs is required');
  return rustModule.parseCargoWorkspace(input);
};

function rustPolicy(overrides = {}) {
  return {
    schemaVersion: 2,
    version: 1,
    language: 'rust',
    productRoots: ['crates'],
    layers: [
      { id: 'contracts', crates: ['game-contracts'] },
      { id: 'core', crates: ['core'] },
      { id: 'world', crates: ['world'] },
      { id: 'render', crates: ['render'] },
      { id: 'app', crates: ['app'] },
    ],
    cycles: 'forbid',
    allowedExternalCrates: ['serde', 'thiserror'],
    allowedDevExternalCrates: ['proptest'],
    contractCrates: ['game-contracts'],
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json', 'Cargo.toml'],
    ...overrides,
  };
}

function defaultWorkspaceFiles() {
  return {
    'Cargo.toml': [
      '[workspace]',
      'resolver = "2"',
      'members = ["crates/*"]',
      '',
      '[workspace.dependencies]',
      'serde = "1.0"',
      'thiserror = "2.0"',
      'proptest = "1.5"',
      'game-contracts = { path = "crates/game-contracts" }',
      'core = { path = "crates/core" }',
      '',
    ].join('\n'),
    'crates/game-contracts/Cargo.toml': [
      '[package]',
      'name = "game-contracts"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'thiserror = { workspace = true }',
      '',
    ].join('\n'),
    'crates/game-contracts/src/lib.rs': 'pub trait WorldView { fn tick(&self) -> u64; }\n',
    'crates/core/Cargo.toml': [
      '[package]',
      'name = "core"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'serde = { workspace = true }',
      '',
      '[dev-dependencies]',
      'proptest = { workspace = true }',
      '',
    ].join('\n'),
    'crates/core/src/lib.rs': 'pub struct Tick(pub u64);\n',
    'crates/world/Cargo.toml': [
      '[package]',
      'name = "world"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'core = { path = "../core" }',
      '',
    ].join('\n'),
    'crates/world/src/lib.rs': 'pub struct World;\n',
    'crates/render/Cargo.toml': [
      '[package]',
      'name = "render"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'world = { path = "../world" }',
      '',
    ].join('\n'),
    'crates/render/src/lib.rs': 'pub struct Renderer;\n',
    'crates/app/Cargo.toml': [
      '[package]',
      'name = "app"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'render = { path = "../render" }',
      '',
    ].join('\n'),
    'crates/app/src/main.rs': 'fn main() {}\n',
  };
}

async function rustFixture(t, { files = {}, policy = rustPolicy() } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-arch-rust-'));
  const project = path.join(scratch, 'project');
  const artifacts = path.join(scratch, 'artifacts');
  await mkdir(project);
  await mkdir(artifacts);
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)),
  );
  await writeFile(path.join(scratch, 'empty.gitconfig'), '');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(scratch, 'empty.gitconfig');
  const git = args =>
    execFileSync('git', ['-c', 'core.hooksPath=' + path.join(scratch, 'no-hooks'), ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Rust Fixture']);
  git(['config', 'user.email', 'rust-fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgSign', 'false']);
  const put = async (file, content) => {
    const full = path.join(project, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf8');
  };
  const commit = (message = 'fixture') => {
    git(['add', '-A']);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };
  for (const [file, content] of Object.entries({ ...defaultWorkspaceFiles(), ...files })) await put(file, content);
  if (policy) await put('architecture.policy.json', policy);
  const baseSha = commit('base');
  return { scratch, project, artifacts, git, put, commit, baseSha, policy };
}

test('parseCargoWorkspace resolves glob members, path deps, workspace deps, dev/build deps and CRLF without cargo', () => {
  const raw = defaultWorkspaceFiles();
  raw['Cargo.toml'] = raw['Cargo.toml'].replaceAll('\n', '\r\n');
  raw['crates/app/Cargo.toml'] += '\r\n[build-dependencies]\r\ncc = "1.0"\r\n';
  raw['crates/ignored/Cargo.toml'] = '[package]\nname = "ignored"\nversion = "0.1.0"\n';
  raw['Cargo.toml'] = raw['Cargo.toml'].replace(
    'members = ["crates/*"]',
    'members = ["crates/*"]\r\nexclude = ["crates/ignored"]',
  );
  const files = Object.keys(raw)
    .sort()
    .map(file => ({ path: file, mode: '100644', oid: 'a'.repeat(40) }));
  const contents = new Map(Object.entries(raw).map(([file, text]) => [file, Buffer.from(text, 'utf8')]));
  const parsed = parseWorkspace({ files, contents });
  assert.deepEqual(parsed.unsupported, []);
  assert.deepEqual(
    parsed.crates.map(crate => crate.name),
    ['app', 'core', 'game-contracts', 'render', 'world'],
  );
  assert.ok(
    parsed.edges.some(edge => edge.from === 'world' && edge.to === 'core' && edge.kind === 'dependency'),
    'direct path dependency world -> core',
  );
  assert.ok(
    parsed.edges.some(edge => edge.from === 'core' && edge.to === 'game-contracts' && edge.workspaceInherited === true),
    'workspace = true path dependency core -> game-contracts',
  );
  assert.ok(
    parsed.edges.some(
      edge => edge.from === 'core' && edge.externalCrate === 'proptest' && edge.kind === 'dev-dependency',
    ),
    'workspace = true dev-dependency',
  );
  assert.ok(
    parsed.edges.some(edge => edge.from === 'app' && edge.externalCrate === 'cc' && edge.kind === 'build-dependency'),
    'build-dependency',
  );
});

test('Rust v2 architecture policy validates ordered layers and rejects malformed configs', () => {
  const p = rustPolicy({
    allowedExternalCrates: ['thiserror', 'serde'],
    protectedPaths: ['Cargo.toml', 'architecture.policy.json'],
  });
  const normalized = validateArchitecturePolicy(p);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.language, 'rust');
  assert.deepEqual(
    normalized.layers.map(layer => layer.id),
    ['contracts', 'core', 'world', 'render', 'app'],
    'layer order must be preserved bottom-to-top',
  );
  assert.deepEqual(normalized.allowedExternalCrates, ['serde', 'thiserror']);
  assert.deepEqual(validateArchitecturePolicy(normalized), normalized);

  const withoutDev = rustPolicy();
  delete withoutDev.allowedDevExternalCrates;
  assert.deepEqual(validateArchitecturePolicy(withoutDev).allowedDevExternalCrates, []);

  assert.throws(
    () => validateArchitecturePolicy(rustPolicy({ contractCrates: ['unknown-crate'] })),
    error => error.code === 'configuration',
  );
  assert.throws(
    () =>
      validateArchitecturePolicy(
        rustPolicy({
          layers: [
            { id: 'a', crates: ['core'] },
            { id: 'b', crates: ['core'] },
          ],
        }),
      ),
    error => error.code === 'configuration',
  );
});

test('Valid Rust Cargo workspace passes Architecture Guardian CLI and gate freshness', async t => {
  const fx = await rustFixture(t);
  await fx.put('crates/world/src/lib.rs', 'pub struct World { pub ticks: u64 }\n');
  const headSha = fx.commit('update world');
  const cliResult = await architectureCli(['check', '--project', fx.project, '--base', fx.baseSha, '--json']);
  assert.equal(cliResult.exitCode, 0);
  assert.equal(cliResult.report.status, 'passed');
  assert.equal(cliResult.report.passed, true);
  assert.deepEqual(cliResult.report.findings, []);
  assert.deepEqual(cliResult.report.unsupported, []);

  const gateOptions = {
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths: ['crates/world'],
  };
  const receipt = await runArchitectureChecks(gateOptions);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.passed, true);
  assert.equal(await isCurrentArchitectureReceipt(receipt, gateOptions), true);
});

test('Lower layer crate depending on upper layer crate produces layer_violation', async t => {
  const fx = await rustFixture(t);
  await fx.put(
    'crates/core/Cargo.toml',
    [
      '[package]',
      'name = "core"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'render = { path = "../render" }',
      '',
    ].join('\n'),
  );
  fx.commit('core depends on render');
  const report = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha });
  assert.equal(report.status, 'failed');
  assert.equal(report.passed, false);
  const violation = report.findings.find(row => row.ruleId === 'layer_violation');
  assert.ok(violation, 'expected layer_violation finding');
  assert.equal(violation.fromModule, 'core');
  assert.equal(violation.toModule, 'render');
  assert.equal(violation.file, 'crates/core/Cargo.toml');
});

test('Cycle between workspace crates produces dependency_cycle', async t => {
  const fx = await rustFixture(t, {
    policy: rustPolicy({
      layers: [
        { id: 'contracts', crates: ['game-contracts'] },
        { id: 'core', crates: ['core'] },
        { id: 'sim', crates: ['world', 'render'] },
        { id: 'app', crates: ['app'] },
      ],
    }),
  });
  await fx.put(
    'crates/world/Cargo.toml',
    [
      '[package]',
      'name = "world"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'core = { path = "../core" }',
      'render = { path = "../render" }',
      '',
    ].join('\n'),
  );
  fx.commit('world <-> render cycle');
  const report = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha });
  assert.equal(report.status, 'failed');
  assert.equal(report.passed, false);
  const cycle = report.findings.find(row => row.ruleId === 'dependency_cycle');
  assert.ok(cycle, 'expected dependency_cycle finding');
  assert.deepEqual(cycle.relatedFiles, ['crates/render/Cargo.toml', 'crates/world/Cargo.toml']);
});

test('External dependency allowlist blocks unlisted crates and package-alias bypasses while allowing listed ones', async t => {
  const fx = await rustFixture(t);
  await fx.put(
    'crates/world/Cargo.toml',
    [
      '[package]',
      'name = "world"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'core = { path = "../core" }',
      'rand = "0.9"',
      'serde = { package = "evil-crate", version = "0.1" }',
      '',
    ].join('\n'),
  );
  fx.commit('add unapproved external crates');
  const report = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha });
  assert.equal(report.status, 'failed');
  assert.equal(report.passed, false);
  const disallowed = report.findings.filter(row => row.ruleId === 'external_dependency_not_allowed');
  assert.deepEqual(disallowed.map(row => row.toModule).sort(), ['evil-crate', 'rand']);

  // Move dev-only crate proptest to [dependencies] -> rejected; keep in [dev-dependencies] -> allowed.
  await fx.put(
    'crates/world/Cargo.toml',
    [
      '[package]',
      'name = "world"',
      'version = "0.1.0"',
      'edition = "2024"',
      '',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'core = { path = "../core" }',
      'proptest = { workspace = true }',
      '',
    ].join('\n'),
  );
  fx.commit('proptest in regular dependencies');
  const devInProd = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha });
  assert.equal(devInProd.status, 'failed');
  assert.ok(
    devInProd.findings.some(row => row.ruleId === 'external_dependency_not_allowed' && row.toModule === 'proptest'),
  );
});

test('Editing a protected contract crate fails for ordinary tasks and passes for explicit contract tasks', async t => {
  const fx = await rustFixture(t);
  await fx.put(
    'crates/game-contracts/src/lib.rs',
    'pub trait WorldView { fn tick(&self) -> u64; fn version(&self) -> u32; }\n',
  );
  const headSha = fx.commit('modify contract crate');

  // Ordinary task (writePaths does not explicitly target crates/game-contracts) -> blocked with contract_change_not_allowed
  for (const taskPaths of [undefined, [], ['crates/world'], ['crates'], ['crates/**']]) {
    const report = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha, taskPaths });
    assert.equal(report.status, 'failed');
    assert.equal(report.passed, false);
    const finding = report.findings.find(row => row.ruleId === 'contract_change_not_allowed');
    assert.ok(finding, `expected contract_change_not_allowed for taskPaths=${JSON.stringify(taskPaths)}`);
    assert.equal(finding.file, 'crates/game-contracts/src/lib.rs');
    assert.equal(finding.fromModule, 'game-contracts');
    // Contract change violations are not eligible for baseline/exception waivers.
    const debt = applyArchitectureDebt({
      findings: [finding],
      baseFindings: [finding],
      baseline: [
        {
          findingId: finding.id,
          owner: 'dev',
          reason: 'attempt waiver',
          reviewAfter: '2999-01-01T00:00:00.000Z',
        },
      ],
      exceptions: [],
      changedPaths: [],
      now: '2026-11-24T00:00:00.000Z',
    });
    assert.equal(debt.activeFindings.length, 1);
    assert.equal(debt.invalidEntries[0]?.reason, 'ineligible');
  }

  // Explicit contract task (writePaths targets crates/game-contracts) -> passes, still requiresReview
  const allowed = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    taskPaths: ['crates/game-contracts'],
  });
  assert.equal(allowed.status, 'passed');
  assert.equal(allowed.passed, true);
  assert.deepEqual(allowed.findings, []);
  assert.equal(allowed.requiresReview, true);
  assert.equal(allowed.fullVerificationRequired, true);

  // Gate freshness preserves taskPaths binding.
  const gateOptions = {
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths: ['crates/game-contracts'],
  };
  const receipt = await runArchitectureChecks(gateOptions);
  assert.equal(receipt.status, 'passed');
  assert.equal(await isCurrentArchitectureReceipt(receipt, gateOptions), true);
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...gateOptions, taskPaths: ['crates/world'] }), false);
});

test('Rust workspace blueprint with >= 3 crates requires a Wave 0 contract crate task (contract_crate_required)', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-bp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const criterion = id => ({ id, text: 'Проходит cargo test', evidenceKinds: ['checks'] });
  const makeTask = (id, epicId, dependsOn, writePaths) => ({
    id,
    epicId,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    owner: 'developer',
    dependsOn,
    writePaths,
    acceptance: [criterion(`${id}-done`)],
    interfaceRefs: [],
    priority: 50,
    userValue: 3,
    risk: 1,
    estimatedEffort: 1,
    riskApprovalRequired: false,
  });
  const markdown = [
    '# Voxel Sandbox',
    '## Цель',
    'Оригинальная воксельная игра.',
    '## Модули',
    'core, world, render, app.',
    '## Стек',
    'Rust 2024, Cargo workspace.',
    '## Критерии готовности',
    '- cargo test проходит.',
  ].join('\n');

  const withoutContracts = {
    schemaVersion: 1,
    id: 'voxel-game',
    root,
    title: 'Voxel Game',
    definitionOfDone: [criterion('done')],
    constraints: ['Cargo workspace'],
    businessContext: 'Rust game',
    architectureRefs: [],
    execution: { cadence: 'wave', integration: 'branch' },
    milestones: [
      { id: 'foundation', title: 'Wave 0', acceptance: [criterion('f-done')], releaseRequired: false },
      { id: 'mvp', title: 'MVP', acceptance: [criterion('m-done')], releaseRequired: false },
    ],
    epics: [
      { id: 'foundation', milestoneId: 'foundation', title: 'Setup', acceptance: [criterion('fe-done')] },
      { id: 'gameplay', milestoneId: 'mvp', title: 'Gameplay', acceptance: [criterion('ge-done')] },
    ],
    tasks: [
      makeTask('scaffold', 'foundation', [], ['Cargo.toml', 'architecture.policy.json']),
      makeTask('core-crate', 'gameplay', ['scaffold'], ['crates/core']),
      makeTask('world-crate', 'gameplay', ['core-crate'], ['crates/world']),
      makeTask('render-crate', 'gameplay', ['world-crate'], ['crates/render']),
    ],
  };

  const missing = lintFactorySpec(withoutContracts, { interfaces: [], projectMarkdown: markdown });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.findings.some(row => row.code === 'contract_crate_required'),
    `expected contract_crate_required, got ${JSON.stringify(missing.findings)}`,
  );

  // Contract crate task in Wave 0 passes.
  const withWave0Contract = structuredClone(withoutContracts);
  withWave0Contract.tasks.splice(
    1,
    0,
    makeTask('contracts-crate', 'foundation', ['scaffold'], ['crates/game-contracts']),
  );
  withWave0Contract.tasks.find(item => item.id === 'core-crate').dependsOn = ['contracts-crate'];
  const valid = lintFactorySpec(withWave0Contract, { interfaces: [], projectMarkdown: markdown });
  assert.deepEqual(valid.findings, []);
  assert.equal(valid.ok, true);

  // Smaller Rust workspace (< 3 crates) does not require contract_crate_required.
  const twoCrates = structuredClone(withoutContracts);
  twoCrates.tasks = [
    makeTask('scaffold', 'foundation', [], ['Cargo.toml']),
    makeTask('core-crate', 'gameplay', ['scaffold'], ['crates/core']),
    makeTask('app-crate', 'gameplay', ['core-crate'], ['crates/app']),
  ];
  const small = lintFactorySpec(twoCrates, { interfaces: [], projectMarkdown: markdown });
  assert.equal(
    small.findings.some(row => row.code === 'contract_crate_required'),
    false,
  );

  // compileBlueprint also surfaces contract_crate_required from disk.
  const bpDir = path.join(root, '.kodo', 'blueprint');
  await mkdir(bpDir, { recursive: true });
  await writeFile(path.join(bpDir, 'PROJECT.md'), markdown);
  await writeFile(path.join(bpDir, 'spec.json'), JSON.stringify(withoutContracts, null, 2));
  const compiled = await compileBlueprint(root);
  assert.equal(compiled.ok, false);
  assert.ok(compiled.findings.some(row => row.code === 'contract_crate_required'));
});

test('readArchitectureGraph and evaluateArchitecture work directly for Rust v2 policy', async t => {
  const fx = await rustFixture(t);
  const headSha = fx.git(['rev-parse', 'HEAD']);
  const policy = validateArchitecturePolicy(fx.policy);
  const graph = await readArchitectureGraph({ project: fx.project, headSha, policy });
  assert.equal(graph.schemaVersion, 2);
  assert.equal(graph.language, 'rust');
  assert.deepEqual(graph.unsupported, []);
  assert.deepEqual(evaluateArchitecture({ policy, graph }), { schemaVersion: 1, findings: [] });
});

test('parseCargoWorkspace handles root package, target deps, and blocks malformed/unsafe workspace inputs', () => {
  const mkFiles = map => ({
    files: Object.keys(map)
      .sort()
      .map(file => ({ path: file, mode: '100644', oid: 'a'.repeat(40) })),
    contents: new Map(Object.entries(map).map(([file, text]) => [file, Buffer.from(text, 'utf8')])),
  });

  // Non-virtual workspace + target-specific dependency.
  const nonVirtual = parseWorkspace(
    mkFiles({
      'Cargo.toml': [
        '[package]',
        'name = "root-app"',
        'version = "0.1.0"',
        '[workspace]',
        'members = ["crates/*"]',
        "[target.'cfg(unix)'.dependencies]",
        'libc = "0.2"',
        '[dependencies]',
        'core = { path = "crates/core" }',
      ].join('\n'),
      'crates/core/Cargo.toml': '[package]\nname = "core"\nversion = "0.1.0"\n',
    }),
  );
  assert.deepEqual(nonVirtual.unsupported, []);
  assert.deepEqual(
    nonVirtual.crates.map(crate => crate.name),
    ['core', 'root-app'],
  );
  assert.ok(nonVirtual.edges.some(edge => edge.from === 'root-app' && edge.to === 'core'));
  assert.ok(nonVirtual.edges.some(edge => edge.from === 'root-app' && edge.externalCrate === 'libc'));

  // Missing Cargo.toml -> missing-cargo-workspace.
  assert.ok(
    parseWorkspace(mkFiles({ 'README.md': 'hi' })).unsupported.some(row => row.reason === 'missing-cargo-workspace'),
  );

  // Unresolved workspace = true, unsafe path escape, out-of-workspace path, malformed TOML, duplicate crate name.
  const broken = parseWorkspace(
    mkFiles({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/a/Cargo.toml': [
        '[package]',
        'name = "dup"',
        'version = "0.1.0"',
        '[dependencies]',
        'missing_ws = { workspace = true }',
        'escaped = { path = "../../../outside" }',
        'outside_ws = { path = "../not-a-member" }',
      ].join('\n'),
      'crates/b/Cargo.toml': '[package]\nname = "dup"\nversion = "0.1.0"\n',
      'crates/bad/Cargo.toml': '[package\nbroken toml',
    }),
  );
  const reasons = new Set(broken.unsupported.map(row => row.reason));
  for (const expected of [
    'unresolved-workspace-dependency',
    'unsafe-path',
    'out-of-workspace-dependency',
    'duplicate-crate-name',
    'parse-error',
  ])
    assert.ok(reasons.has(expected), `expected unsupported reason ${expected}, got ${JSON.stringify([...reasons])}`);
});

test('Removing a crate from contractCrates in the same commit does not bypass contract_change_not_allowed, and unowned crates fail ownership', async t => {
  const fx = await rustFixture(t);
  // Try removing game-contracts from contractCrates while editing its source with an ordinary task.
  await fx.put('architecture.policy.json', rustPolicy({ contractCrates: [] }));
  await fx.put('crates/game-contracts/src/lib.rs', 'pub trait WorldView { fn hacked(&self); }\n');
  // Also add an unowned crate to the workspace.
  await fx.put('crates/stray/Cargo.toml', '[package]\nname = "stray"\nversion = "0.1.0"\nedition = "2024"\n');
  await fx.put('crates/stray/src/lib.rs', 'pub fn stray() {}\n');
  fx.commit('bypass attempt and unowned crate');
  const report = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha, taskPaths: ['crates/world'] });
  assert.equal(report.status, 'failed');
  assert.ok(
    report.findings.some(
      row => row.ruleId === 'contract_change_not_allowed' && row.file === 'crates/game-contracts/src/lib.rs',
    ),
    'base contractCrates must still protect contract crate even if head removes it',
  );
  assert.ok(
    report.findings.some(row => row.ruleId === 'ownership.unowned' && row.fromModule === 'stray'),
    'unassigned workspace crate must produce ownership.unowned',
  );
});

test('apply-spec CLI surfaces contract_crate_required with exit 1 for Rust workspace >= 3 crates without Wave 0 contract crate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-apply-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const criterion = id => ({ id, text: 'cargo test passes', evidenceKinds: ['checks'] });
  const makeTask = (id, epicId, dependsOn, writePaths) => ({
    id,
    epicId,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    owner: 'developer',
    dependsOn,
    writePaths,
    acceptance: [criterion(`${id}-done`)],
    interfaceRefs: [],
    priority: 50,
    userValue: 3,
    risk: 1,
    estimatedEffort: 1,
    riskApprovalRequired: false,
  });
  const bpDir = path.join(root, '.kodo', 'blueprint');
  await mkdir(bpDir, { recursive: true });
  await writeFile(
    path.join(bpDir, 'PROJECT.md'),
    '# Rust App\n## Цель\nИгра.\n## Модули\ncore, world, render.\n## Стек\nRust, Cargo.\n## Критерии готовности\n- cargo test\n',
  );
  await writeFile(
    path.join(bpDir, 'spec.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'rust-app',
      root,
      title: 'Rust App',
      definitionOfDone: [criterion('done')],
      constraints: [],
      businessContext: 'Rust game',
      architectureRefs: [],
      execution: { cadence: 'wave', integration: 'branch' },
      milestones: [
        { id: 'foundation', title: 'Wave 0', acceptance: [criterion('f-done')], releaseRequired: false },
        { id: 'mvp', title: 'MVP', acceptance: [criterion('m-done')], releaseRequired: false },
      ],
      epics: [
        { id: 'foundation', milestoneId: 'foundation', title: 'Setup', acceptance: [criterion('fe-done')] },
        { id: 'mvp', milestoneId: 'mvp', title: 'MVP', acceptance: [criterion('me-done')] },
      ],
      tasks: [
        makeTask('scaffold', 'foundation', [], ['Cargo.toml']),
        makeTask('core', 'mvp', ['scaffold'], ['crates/core']),
        makeTask('world', 'mvp', ['core'], ['crates/world']),
        makeTask('render', 'mvp', ['world'], ['crates/render']),
      ],
    }),
  );
  const res = await projectBlueprintCli(['apply-spec', '--root', root, '--json'], { home, secrets: {} });
  assert.equal(res.exitCode, 1);
  assert.equal(res.report.result.code, 'blueprint_findings');
  assert.ok(res.report.result.findings.some(row => row.code === 'contract_crate_required'));
});

test('E1: Wave 0 from scratch (base without Cargo.toml or policy) passes checkArchitecture and runArchitectureChecks', async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-arch-rust-w0-'));
  const project = path.join(scratch, 'project');
  const artifacts = path.join(scratch, 'artifacts');
  await mkdir(project);
  await mkdir(artifacts);
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)),
  );
  await writeFile(path.join(scratch, 'empty.gitconfig'), '');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(scratch, 'empty.gitconfig');
  const git = args =>
    execFileSync('git', ['-c', 'core.hooksPath=' + path.join(scratch, 'no-hooks'), ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'Wave0 Fixture']);
  git(['config', 'user.email', 'wave0@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgSign', 'false']);
  const put = async (file, content) => {
    const full = path.join(project, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf8');
  };
  const commit = message => {
    git(['add', '-A']);
    git(['commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']);
  };

  // Base commit: no Cargo.toml, no architecture.policy.json (initial repo before Wave 0)
  await put('README.md', '# New Rust Project\n');
  await put('kodo.config.json', { client: 'codex', architecture: { enabled: true } });
  const baseSha = commit('initial commit before wave 0');

  // Head commit: Wave 0 creates Cargo workspace, contract crate, and architecture.policy.json v2
  for (const [file, content] of Object.entries(defaultWorkspaceFiles())) await put(file, content);
  await put('architecture.policy.json', rustPolicy());
  const headSha = commit('wave 0 workspace and contracts');

  const taskPaths = ['Cargo.toml', 'architecture.policy.json', 'crates/game-contracts'];
  const report = await checkArchitecture({ project, baseSha, taskPaths });
  assert.equal(report.status, 'passed', `expected passed, got ${JSON.stringify(report)}`);
  assert.equal(report.passed, true);
  assert.equal(report.basePolicyState, 'absent');
  assert.equal(report.baseRulesEvaluated, false);
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.findings, []);

  const gateOptions = {
    cwd: project,
    baseSha,
    headSha,
    config: { enabled: true },
    artifacts,
    taskPaths,
  };
  const receipt = await runArchitectureChecks(gateOptions);
  assert.equal(receipt.status, 'passed', `expected passed receipt, got ${JSON.stringify(receipt)}`);
  assert.equal(receipt.passed, true);
  assert.equal(await isCurrentArchitectureReceipt(receipt, gateOptions), true);
});

test('E2: cargo-workspace resolves workspace members matching real Cargo 1.96 metadata fixtures offline', async () => {
  const mod = await import('../runtime/cargo-workspace.mjs');
  const fixturesDir = path.join(import.meta.dirname, 'fixtures', 'cargo-metadata');
  const entries = (await readdir(fixturesDir)).filter(name => name.endsWith('.json')).sort();
  assert.ok(entries.length >= 7, 'expected at least 7 cargo metadata fixtures');
  for (const name of entries) {
    const fixture = JSON.parse(await readFile(path.join(fixturesDir, name), 'utf8'));
    const contents = new Map(
      Object.entries(fixture.manifests).map(([file, text]) => [file, Buffer.from(text, 'utf8')]),
    );
    const resolved = mod.resolveCargoWorkspace({ manifests: contents, startDir: fixture.startDir || '' });
    assert.deepEqual(
      resolved.unsupported,
      [],
      `${name}: unexpected unsupported ${JSON.stringify(resolved.unsupported)}`,
    );
    assert.equal(resolved.root, fixture.workspace_root, `${name}: workspace root mismatch`);
    assert.deepEqual(
      resolved.members.map(member => ({ name: member.name, manifest: member.manifest })),
      fixture.workspace_members,
      `${name}: workspace members mismatch`,
    );
  }

  // Malformed glob -> unsupported-member-glob; unexcluded nested [workspace] -> nested-workspace-root.
  const badGlob = mod.resolveCargoWorkspace({
    manifests: new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["crates/[unclosed"]\n'],
      ['crates/a/Cargo.toml', '[package]\nname = "a"\nversion = "0.1.0"\n'],
    ]),
  });
  assert.ok(badGlob.unsupported.some(row => row.reason === 'unsupported-member-glob'));

  const nestedConflict = mod.resolveCargoWorkspace({
    manifests: new Map([
      ['Cargo.toml', '[workspace]\nmembers = ["crates/a"]\n'],
      [
        'crates/a/Cargo.toml',
        '[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nsub = { path = "../subws" }\n',
      ],
      ['crates/subws/Cargo.toml', '[package]\nname = "sub"\nversion = "0.1.0"\n[workspace]\n'],
    ]),
  });
  assert.ok(nestedConflict.unsupported.some(row => row.reason === 'nested-workspace-root'));
});
