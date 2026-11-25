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
import { Engine } from '../runtime/engine.mjs';
import {
  fixture as engineFixture,
  fakeServices,
  node as planNode,
  git as fixtureGit,
} from './helpers/engine-fixture.mjs';
import { applyArchitectureDebt } from '../runtime/architecture-debt.mjs';
import { compileBlueprint, lintFactorySpec, rustContractCrateFindings } from '../runtime/project-blueprint.mjs';
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
    const resolved = mod.resolveCargoWorkspace({
      manifests: contents,
      files: fixture.files,
      startDir: fixture.startDir || '',
    });
    if (fixture.ok === false) {
      assert.ok(
        resolved.unsupported.some(row => row.reason === fixture.expectedReason),
        `${name}: expected unsupported reason ${fixture.expectedReason}, got ${JSON.stringify(resolved.unsupported)}`,
      );
      continue;
    }
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
    if (fixture.member_dependencies) {
      const parsed = parseWorkspace({
        files: (fixture.files || Object.keys(fixture.manifests)).map(file => ({
          path: file,
          mode: '100644',
          oid: 'a'.repeat(40),
        })),
        contents,
      });
      assert.deepEqual(parsed.unsupported, [], `${name}: parseWorkspace unexpected unsupported`);
      const actualDeps = Object.fromEntries(
        parsed.crates
          .map(crate => [
            crate.name,
            parsed.edges
              .filter(edge => edge.from === crate.name)
              .map(edge => ({ name: edge.to ?? edge.externalCrate, kind: edge.kind }))
              .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
          ])
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      assert.deepEqual(actualDeps, fixture.member_dependencies, `${name}: member dependencies mismatch`);
    }
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

test('E3: underscore dep tables, workspace=true package conflict, and [patch]/[replace]/.cargo/config blocking', async t => {
  const mkFiles = map => ({
    files: Object.keys(map)
      .sort()
      .map(file => ({ path: file, mode: '100644', oid: 'a'.repeat(40) })),
    contents: new Map(Object.entries(map).map(([file, text]) => [file, Buffer.from(text, 'utf8')])),
  });

  // 1) [dev_dependencies], [build_dependencies], and target.* underscore variants
  const underscore = parseWorkspace(
    mkFiles({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/a/Cargo.toml': [
        '[package]',
        'name = "a"',
        'version = "0.1.0"',
        '[dev_dependencies]',
        'proptest = "1.0"',
        '[build_dependencies]',
        'cc = "1.0"',
        "[target.'cfg(unix)'.dev_dependencies]",
        'nix = "0.29"',
        "[target.'cfg(windows)'.build_dependencies]",
        'winres = "0.1"',
      ].join('\n'),
    }),
  );
  assert.deepEqual(underscore.unsupported, []);
  assert.ok(underscore.edges.some(e => e.externalCrate === 'proptest' && e.kind === 'dev-dependency'));
  assert.ok(underscore.edges.some(e => e.externalCrate === 'cc' && e.kind === 'build-dependency'));
  assert.ok(underscore.edges.some(e => e.externalCrate === 'nix' && e.kind === 'dev-dependency'));
  assert.ok(underscore.edges.some(e => e.externalCrate === 'winres' && e.kind === 'build-dependency'));

  // 2) workspace = true with package override in member -> unsupported
  const wsConflict = parseWorkspace(
    mkFiles({
      'Cargo.toml':
        '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\nser = { package = "serde", version = "1.0" }\n',
      'crates/a/Cargo.toml':
        '[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nser = { workspace = true, package = "evil" }\n',
    }),
  );
  assert.ok(
    wsConflict.unsupported.some(row => row.reason === 'conflicting-workspace-package'),
    `expected conflicting-workspace-package, got ${JSON.stringify(wsConflict.unsupported)}`,
  );

  // 3) Root [patch], [replace], and .cargo/config.toml [patch] -> unsupported + blocked in CLI
  const withPatch = parseWorkspace(
    mkFiles({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n[patch.crates-io]\nserde = { path = "crates/b" }\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nserde = "1.0"\n',
      'crates/b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
    }),
  );
  assert.ok(
    withPatch.unsupported.some(row => row.reason === 'unsupported-cargo-patch' && row.file === 'Cargo.toml'),
    `expected unsupported-cargo-patch, got ${JSON.stringify(withPatch.unsupported)}`,
  );

  const withReplace = parseWorkspace(
    mkFiles({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n[replace]\n"serde:1.0.0" = { path = "crates/b" }\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'crates/b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\n',
    }),
  );
  assert.ok(
    withReplace.unsupported.some(row => row.reason === 'unsupported-cargo-replace' && row.file === 'Cargo.toml'),
    `expected unsupported-cargo-replace, got ${JSON.stringify(withReplace.unsupported)}`,
  );

  // End-to-end check with .cargo/config.toml [patch] via checkArchitecture -> blocked
  const fx = await rustFixture(t);
  await fx.put('.cargo/config.toml', '[patch.crates-io]\nserde = { path = "crates/render" }\n');
  fx.commit('add .cargo/config.toml patch');
  const blocked = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.passed, false);
  assert.ok(
    blocked.unsupported.some(row => row.reason === 'unsupported-cargo-patch' && row.file === '.cargo/config.toml'),
    `expected unsupported-cargo-patch for .cargo/config.toml, got ${JSON.stringify(blocked.unsupported)}`,
  );
});

test('E4: contract protection checks base U head (moved crate & root deleted file), missing contract crate, and contract_scope_too_broad', async t => {
  // 1) Moving contract crate with the same package name: base path must still be protected.
  const fxMove = await rustFixture(t);
  await fxMove.put(
    'Cargo.toml',
    defaultWorkspaceFiles()['Cargo.toml'].replace('crates/game-contracts', 'crates/moved-contracts'),
  );
  await fxMove.put('crates/moved-contracts/Cargo.toml', defaultWorkspaceFiles()['crates/game-contracts/Cargo.toml']);
  await fxMove.put(
    'crates/moved-contracts/src/lib.rs',
    'pub trait WorldView { fn tick(&self) -> u64; fn extra(&self); }\n',
  );
  await rm(path.join(fxMove.project, 'crates/game-contracts'), { recursive: true, force: true });
  fxMove.commit('move game-contracts to crates/moved-contracts');
  const moveReport = await checkArchitecture({
    project: fxMove.project,
    baseSha: fxMove.baseSha,
    taskPaths: ['crates/moved-contracts'],
  });
  assert.equal(moveReport.status, 'failed');
  assert.ok(
    moveReport.findings.some(
      row => row.ruleId === 'contract_change_not_allowed' && row.file === 'crates/game-contracts/src/lib.rs',
    ),
    `expected base contract location to be protected on move, got ${JSON.stringify(moveReport.findings)}`,
  );

  // 2) Root contract crate deleting src/old.rs must be caught via base crate file list.
  const rootPolicy = rustPolicy({
    productRoots: ['src'],
    layers: [
      { id: 'contracts', crates: ['root-contracts'] },
      { id: 'app', crates: ['app'] },
    ],
    contractCrates: ['root-contracts'],
  });
  const fxRoot = await rustFixture(t, {
    policy: rootPolicy,
    files: {
      'Cargo.toml':
        '[package]\nname = "root-contracts"\nversion = "0.1.0"\nedition = "2024"\n[workspace]\nmembers = ["crates/app"]\n',
      'src/lib.rs': 'pub mod old;\n',
      'src/old.rs': 'pub trait Legacy {}\n',
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\nroot-contracts = { path = "../.." }\n',
      'crates/app/src/main.rs': 'fn main() {}\n',
    },
  });
  await rm(path.join(fxRoot.project, 'src/old.rs'));
  fxRoot.commit('delete root contract file src/old.rs');
  const rootDeleteReport = await checkArchitecture({
    project: fxRoot.project,
    baseSha: fxRoot.baseSha,
    taskPaths: ['crates/app'],
  });
  assert.equal(rootDeleteReport.status, 'failed');
  assert.ok(
    rootDeleteReport.findings.some(row => row.ruleId === 'contract_change_not_allowed' && row.file === 'src/old.rs'),
    `expected deleted root contract file src/old.rs to trigger contract_change_not_allowed, got ${JSON.stringify(rootDeleteReport.findings)}`,
  );

  // 3) Declared contractCrates entry that is not an actual workspace member on head -> contract_crate_missing.
  const fxMissing = await rustFixture(t, {
    policy: rustPolicy({
      layers: [
        { id: 'contracts', crates: ['game-contracts', 'ghost-contracts'] },
        { id: 'core', crates: ['core'] },
        { id: 'world', crates: ['world'] },
        { id: 'render', crates: ['render'] },
        { id: 'app', crates: ['app'] },
      ],
      contractCrates: ['game-contracts', 'ghost-contracts'],
    }),
  });
  const missingReport = await checkArchitecture({ project: fxMissing.project, baseSha: fxMissing.baseSha });
  assert.equal(missingReport.status, 'failed');
  assert.ok(
    missingReport.findings.some(row => row.ruleId === 'contract_crate_missing' && row.fromModule === 'ghost-contracts'),
    `expected contract_crate_missing for ghost-contracts, got ${JSON.stringify(missingReport.findings)}`,
  );

  // 4) Blueprint rule: ordinary task writePaths covering contract crate (e.g. crates/**) -> contract_scope_too_broad.
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-broad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const criterion = id => ({ id, text: 'cargo test passes', evidenceKinds: ['checks'] });
  const mkTask = (id, epicId, dependsOn, writePaths) => ({
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
  const broadSpec = {
    schemaVersion: 1,
    id: 'broad-rust',
    root,
    title: 'Broad Rust',
    definitionOfDone: [criterion('done')],
    constraints: [],
    businessContext: 'Rust workspace',
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
      mkTask('wave0-contracts', 'foundation', [], ['Cargo.toml', 'architecture.policy.json', 'crates/game-contracts']),
      mkTask('broad-task', 'mvp', ['wave0-contracts'], ['crates/**']),
      mkTask('render-task', 'mvp', ['broad-task'], ['crates/render']),
    ],
  };
  const broadLint = lintFactorySpec(broadSpec, {
    interfaces: [],
    projectMarkdown: '# Game\n## Цель\nИгра.\n## Модули\ncore.\n## Стек\nRust Cargo.\n## Критерии готовности\n- ok\n',
  });
  assert.equal(broadLint.ok, false);
  const broadFinding = broadLint.findings.find(row => row.code === 'contract_scope_too_broad');
  assert.ok(broadFinding, `expected contract_scope_too_broad, got ${JSON.stringify(broadLint.findings)}`);
  assert.deepEqual(broadFinding.taskIds, ['broad-task']);
});

test('E5: contract_crate_required requires Cargo.toml + src/**, supports explicit contract crate declaration (crates/protocol), and ignores independent crates without shared workspace', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-e5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const criterion = id => ({ id, text: 'cargo test passes', evidenceKinds: ['checks'] });
  const mkTask = (id, epicId, dependsOn, writePaths) => ({
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
  const baseSpec = tasks => ({
    schemaVersion: 1,
    id: 'rust-e5',
    root,
    title: 'Rust E5',
    definitionOfDone: [criterion('done')],
    constraints: [],
    businessContext: 'Rust project',
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
    tasks,
  });
  const wsMarkdown = [
    '# Game',
    '## Цель',
    'Игра.',
    '## Модули',
    'core, world, render.',
    '## Стек',
    'Rust 2024, Cargo workspace.',
    '## Критерии готовности',
    '- cargo test',
  ].join('\n');

  // 1) README.md alone in Wave 0 does NOT satisfy contract_crate_required
  const readmeOnly = lintFactorySpec(
    baseSpec([
      mkTask('w0', 'foundation', [], ['Cargo.toml', 'architecture.policy.json', 'crates/game-contracts/README.md']),
      mkTask('core', 'mvp', ['w0'], ['crates/core']),
      mkTask('world', 'mvp', ['core'], ['crates/world']),
      mkTask('render', 'mvp', ['world'], ['crates/render']),
    ]),
    { interfaces: [], projectMarkdown: wsMarkdown },
  );
  assert.equal(readmeOnly.ok, false);
  assert.ok(
    readmeOnly.findings.some(row => row.code === 'contract_crate_required'),
    `README.md alone must not satisfy contract_crate_required, got ${JSON.stringify(readmeOnly.findings)}`,
  );

  // Explicit Cargo.toml + src/** in Wave 0 DOES satisfy contract_crate_required
  const manifestAndSrc = lintFactorySpec(
    baseSpec([
      mkTask(
        'w0',
        'foundation',
        [],
        ['Cargo.toml', 'architecture.policy.json', 'crates/game-contracts/Cargo.toml', 'crates/game-contracts/src/**'],
      ),
      mkTask('core', 'mvp', ['w0'], ['crates/core']),
      mkTask('world', 'mvp', ['core'], ['crates/world']),
      mkTask('render', 'mvp', ['world'], ['crates/render']),
    ]),
    { interfaces: [], projectMarkdown: wsMarkdown },
  );
  assert.deepEqual(manifestAndSrc.findings, []);
  assert.equal(manifestAndSrc.ok, true);

  // 2) Explicitly declared contract crate without *-contracts suffix (crates/protocol) passes
  const protocolMarkdown = wsMarkdown + '\ncontractCrate: crates/protocol\n';
  const withProtocol = lintFactorySpec(
    baseSpec([
      mkTask('w0', 'foundation', [], ['Cargo.toml', 'architecture.policy.json', 'crates/protocol']),
      mkTask('core', 'mvp', ['w0'], ['crates/core']),
      mkTask('world', 'mvp', ['core'], ['crates/world']),
      mkTask('render', 'mvp', ['world'], ['crates/render']),
    ]),
    { interfaces: [], projectMarkdown: protocolMarkdown },
  );
  assert.deepEqual(
    withProtocol.findings,
    [],
    `explicitly declared crates/protocol must pass, got ${JSON.stringify(withProtocol.findings)}`,
  );
  assert.equal(withProtocol.ok, true);

  // Also works when contract crate is declared via architecturePolicy option (policy.contractCrates)
  const withPolicyDecl = lintFactorySpec(
    baseSpec([
      mkTask('w0', 'foundation', [], ['Cargo.toml', 'architecture.policy.json', 'crates/protocol']),
      mkTask('core', 'mvp', ['w0'], ['crates/core']),
      mkTask('world', 'mvp', ['core'], ['crates/world']),
      mkTask('render', 'mvp', ['world'], ['crates/render']),
    ]),
    {
      interfaces: [],
      projectMarkdown: wsMarkdown,
      architecturePolicy: rustPolicy({
        layers: [
          { id: 'contracts', crates: ['protocol'] },
          { id: 'core', crates: ['core'] },
          { id: 'world', crates: ['world'] },
          { id: 'render', crates: ['render'] },
        ],
        contractCrates: ['protocol'],
      }),
    },
  );
  assert.deepEqual(withPolicyDecl.findings, []);

  // 3) Three independent Rust CLI tools without a shared workspace root are NOT a workspace
  const independentToolsMarkdown = [
    '# Rust Tools',
    '## Цель',
    'Набор независимых утилит.',
    '## Модули',
    'tools/lint, tools/fmt, tools/gen.',
    '## Стек',
    'Rust 2024.',
    '## Критерии готовности',
    '- cargo test в каждой утилите',
  ].join('\n');
  const independentTools = lintFactorySpec(
    baseSpec([
      mkTask('w0', 'foundation', [], ['scripts/check.mjs']),
      mkTask('lint', 'mvp', ['w0'], ['tools/lint/Cargo.toml', 'tools/lint/src/**']),
      mkTask('fmt', 'mvp', ['lint'], ['tools/fmt/Cargo.toml', 'tools/fmt/src/**']),
      mkTask('gen', 'mvp', ['fmt'], ['tools/gen/Cargo.toml', 'tools/gen/src/**']),
    ]),
    { interfaces: [], projectMarkdown: independentToolsMarkdown },
  );
  assert.equal(
    independentTools.findings.some(row => row.code === 'contract_crate_required'),
    false,
    `independent tools without workspace root must not trigger contract_crate_required, got ${JSON.stringify(independentTools.findings)}`,
  );
});

test('E8: disabled gate ignores invalid taskPaths, normalizes ./ in taskPaths, exposes unsupported reasons and requiresReview in Engine', async t => {
  const fx = await rustFixture(t);
  await fx.put(
    'crates/game-contracts/src/lib.rs',
    'pub trait WorldView { fn tick(&self) -> u64; fn v2(&self) -> u32; }\n',
  );
  const headSha = fx.commit('contract edit for E8');

  // 1) Disabled gate returns disabled even if taskPaths is invalid (no throw).
  const disabled = await runArchitectureChecks({
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha,
    config: { enabled: false },
    artifacts: fx.artifacts,
    taskPaths: /** @type {any} */ ([123]),
  });
  assert.equal(disabled.status, 'disabled');

  // 2) ./ prefix in taskPaths is normalized and binds freshness + exposes requiresReview/fullVerificationRequired.
  const dotSlashOpts = {
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths: ['./crates/game-contracts/'],
  };
  const receipt = await runArchitectureChecks(dotSlashOpts);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.requiresReview, true);
  assert.equal(receipt.fullVerificationRequired, true);
  assert.deepEqual(receipt.taskPaths, ['crates/game-contracts']);
  assert.equal(
    await isCurrentArchitectureReceipt(receipt, { ...dotSlashOpts, taskPaths: ['crates/game-contracts'] }),
    true,
  );
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...dotSlashOpts, taskPaths: [] }), false);
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...dotSlashOpts, taskPaths: ['crates/world'] }), false);

  // 3) Engine passes run.plan.tasks[].writePaths to runArchitectureChecks & isCurrentArchitectureReceipt,
  //    forwards requiresReview/fullVerificationRequired to review prompt, and surfaces unsupported reasons on blocked.
  const observed = { run: null, current: [] };
  // The Rust test registry of the full gate (15E2) is not under test here: this fixture has no
  // Cargo.lock and no ignored target/, so a registry build would dirty the checked worktree.
  const efx = await engineFixture(t, {
    config: {
      architecture: { enabled: true },
      verification: { testRegistry: false },
      repairRounds: 1,
      researchBudget: 0,
      concurrency: 1,
    },
    testScript: 'process.exit(0);\n',
  });
  const services = fakeServices();
  const engine = new Engine({
    store: efx.openStore(),
    ...services,
    gates: {
      runArchitectureChecks: async opts => {
        observed.run = opts;
        return runArchitectureChecks(opts);
      },
      isCurrentArchitectureReceipt: async (r, opts) => {
        observed.current.push(opts);
        return isCurrentArchitectureReceipt(r, opts);
      },
    },
  });
  const run = await engine.create('Update Rust contract crate', {
    project: efx.project,
    mode: 'quick',
    model: 'gpt-6.1-sol',
  });
  await engine.prepare(run);
  run.models = await services.provider.discoverProviders();
  run.plan = {
    summary: 'Enroll Rust workspace and contract crate',
    tasks: [
      planNode('contract-task', 'developer', ['./Cargo.toml', './architecture.policy.json', './crates/game-contracts']),
    ],
  };
  const putRun = async (file, content) => {
    const full = path.join(run.cwd, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf8');
  };
  for (const [file, content] of Object.entries(defaultWorkspaceFiles())) await putRun(file, content);
  await putRun('architecture.policy.json', rustPolicy());
  fixtureGit(run.cwd, 'add', '.');
  fixtureGit(run.cwd, 'commit', '-m', 'Wave 0 Rust workspace and contract crate');
  run.headSha = fixtureGit(run.cwd, 'rev-parse', 'HEAD');
  engine.save(run);

  await engine.verify(run);
  assert.deepEqual(observed.run?.taskPaths, ['./Cargo.toml', './architecture.policy.json', './crates/game-contracts']);
  assert.ok(observed.current.length >= 2, 'expected freshness check both in gate and after review');
  assert.deepEqual(observed.current[0]?.taskPaths, [
    './Cargo.toml',
    './architecture.policy.json',
    './crates/game-contracts',
  ]);
  assert.deepEqual(observed.current.at(-1)?.taskPaths, [
    './Cargo.toml',
    './architecture.policy.json',
    './crates/game-contracts',
  ]);
  assert.equal(run.architectureChecks.status, 'passed');
  assert.equal(run.architectureChecks.requiresReview, true);
  assert.ok(
    services.calls.review.some(
      req => req.prompt.includes('requiresReview') && req.prompt.includes('fullVerificationRequired'),
    ),
    'reviewer prompt must surface requiresReview/fullVerificationRequired',
  );

  // Blocked architecture gate with unsupported reason must surface unsupported.<reason> in gate error findings.
  await putRun('.cargo/config.toml', '[patch.crates-io]\nserde = { path = "crates/render" }\n');
  fixtureGit(run.cwd, 'add', '.');
  fixtureGit(run.cwd, 'commit', '-m', 'Add unsupported cargo patch');
  run.headSha = fixtureGit(run.cwd, 'rev-parse', 'HEAD');
  engine.save(run);
  await engine.checks(run);
  await assert.rejects(
    () => engine.verificationGates(run),
    err => {
      assert.equal(err.code, 'verification_failed');
      const failures = JSON.parse(err.message.slice(err.message.indexOf('[')));
      const archFailure = failures.find(f => f.gate === 'architectureChecks');
      assert.ok(archFailure, `expected architectureChecks failure, got ${err.message}`);
      assert.equal(archFailure.status, 'blocked');
      assert.ok(
        archFailure.findings.some(
          f => f.ruleId === 'unsupported.unsupported-cargo-patch' && f.file === '.cargo/config.toml',
        ),
        `expected unsupported.unsupported-cargo-patch in failure findings, got ${JSON.stringify(archFailure.findings)}`,
      );
      return true;
    },
  );
});

test('E7: SKILL.md and BLUEPRINT.md document Wave 0 architecture.policy.json writePaths, architecture.enabled in kodo.config.json, and accurate apply-spec remediation', async () => {
  const skill = await readFile(
    path.join(import.meta.dirname, '..', 'skills', 'kodo-project-director', 'SKILL.md'),
    'utf8',
  );
  const blueprintDoc = await readFile(path.join(import.meta.dirname, '..', 'docs', 'BLUEPRINT.md'), 'utf8');
  const bootstrapSrc = await readFile(path.join(import.meta.dirname, '..', 'runtime', 'project-bootstrap.mjs'), 'utf8');
  for (const [label, text] of [
    ['SKILL.md', skill],
    ['docs/BLUEPRINT.md', blueprintDoc],
    ['runtime/project-bootstrap.mjs', bootstrapSrc],
  ]) {
    assert.match(
      text,
      /architecture\.enabled|"architecture"\s*:\s*\{\s*"enabled"\s*:\s*true\s*\}/,
      `${label}: must instruct enabling architecture gate in kodo.config.json`,
    );
    assert.match(
      text,
      /architecture\.policy\.json[^\n]*writePaths|writePaths[^\n]*architecture\.policy\.json/,
      `${label}: must require Wave 0 task to include architecture.policy.json in writePaths`,
    );
    assert.match(text, /contract_scope_too_broad/, `${label}: must document contract_scope_too_broad`);
    assert.match(
      text,
      /members\s*=\s*\["crates\/\*"\]/,
      `${label}: must instruct Wave 0 to set members = ["crates/*"]`,
    );
    assert.match(
      text,
      /layers[^\n]*(?:все|ВСЕ|карты модулей|будущ)/i,
      `${label}: must instruct Wave 0 to pre-populate all module crates in layers`,
    );
  }
  const applySpecLine = skill
    .split('\n')
    .find(line => line.includes('contract_crate_required') && line.includes('blueprint_findings'));
  assert.ok(applySpecLine, 'SKILL.md must explain contract_crate_required in apply-spec remediation');
  assert.equal(
    applySpecLine.includes('добавь его в `contractCrates` в `architecture.policy.json`'),
    false,
    'SKILL.md apply-spec step must not tell coordinator to edit non-existent architecture.policy.json before Wave 0',
  );
});

test('W1: end-to-end Wave 0 (contracts + all planned crates in layers, members=["crates/*"]) -> Wave 1 adds crates/world -> PASS; ordinary contract edit -> blocked; migration -> PASS with requiresReview', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-w1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'repo');
  const artifacts = path.join(root, 'artifacts');
  await mkdir(project, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const put = async (rel, content) => {
    const full = path.join(project, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  };
  const runGit = (...args) =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  // Initial commit before Wave 0: only kodo.config.json (architecture.enabled = true), no Cargo.toml, no policy.
  runGit('init');
  runGit('config', 'user.email', 'test@example.com');
  runGit('config', 'user.name', 'Test');
  await put('kodo.config.json', { client: 'codex', architecture: { enabled: true } });
  runGit('add', '-A');
  runGit('commit', '-m', 'initial');
  const base0 = runGit('rev-parse', 'HEAD');

  // Wave 0: creates Cargo.toml with members = ["crates/*"], contract crate only,
  // and architecture.policy.json listing ALL planned module crates in layers.
  await put('Cargo.toml', '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n');
  await put(
    'crates/game-contracts/Cargo.toml',
    '[package]\nname = "game-contracts"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  await put('crates/game-contracts/src/lib.rs', 'pub struct WorldId(pub u64);\n');
  await put('architecture.policy.json', {
    schemaVersion: 2,
    version: 1,
    language: 'rust',
    productRoots: ['crates'],
    layers: [
      { id: 'contracts', crates: ['game-contracts'] },
      { id: 'domain', crates: ['world', 'combat'] },
      { id: 'app', crates: ['game-cli'] },
    ],
    cycles: 'forbid',
    allowedExternalCrates: ['serde'],
    allowedDevExternalCrates: [],
    contractCrates: ['game-contracts'],
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json'],
  });
  runGit('add', '-A');
  runGit('commit', '-m', 'wave 0: contracts and full layers policy');
  const wave0Head = runGit('rev-parse', 'HEAD');

  const wave0Receipt = await runArchitectureChecks({
    cwd: project,
    baseSha: base0,
    headSha: wave0Head,
    config: { enabled: true },
    artifacts,
    taskPaths: [
      'Cargo.toml',
      'crates/game-contracts/Cargo.toml',
      'crates/game-contracts/src/**',
      'architecture.policy.json',
    ],
  });
  assert.equal(wave0Receipt.status, 'passed', `Wave 0 failed: ${JSON.stringify(wave0Receipt.report)}`);
  assert.equal(wave0Receipt.passed, true);

  // Wave 1: ordinary task adds crates/world without touching Cargo.toml or architecture.policy.json -> PASS.
  await put(
    'crates/world/Cargo.toml',
    '[package]\nname = "world"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\ngame-contracts = { path = "../game-contracts" }\n',
  );
  await put('crates/world/src/lib.rs', 'pub use game_contracts::WorldId;\n');
  runGit('add', '-A');
  runGit('commit', '-m', 'wave 1: add crates/world');
  const wave1Head = runGit('rev-parse', 'HEAD');

  const wave1Receipt = await runArchitectureChecks({
    cwd: project,
    baseSha: wave0Head,
    headSha: wave1Head,
    config: { enabled: true },
    artifacts,
    taskPaths: ['crates/world/**'],
  });
  assert.equal(wave1Receipt.status, 'passed', `Wave 1 failed: ${JSON.stringify(wave1Receipt.report)}`);
  assert.equal(wave1Receipt.passed, true);
  assert.equal(wave1Receipt.requiresReview, false);

  // Ordinary task edits protected contract crate -> blocked with contract_change_not_allowed.
  await put('crates/game-contracts/src/lib.rs', 'pub struct WorldId(pub u128);\n');
  runGit('add', '-A');
  runGit('commit', '-m', 'contract change');
  const contractEditHead = runGit('rev-parse', 'HEAD');

  const ordinaryReceipt = await runArchitectureChecks({
    cwd: project,
    baseSha: wave1Head,
    headSha: contractEditHead,
    config: { enabled: true },
    artifacts,
    taskPaths: ['crates/world/**'],
  });
  assert.equal(ordinaryReceipt.status, 'failed');
  assert.ok(ordinaryReceipt.report.findings.some(f => f.ruleId === 'contract_change_not_allowed'));

  // Explicit contract migration task -> PASS with requiresReview = true & fullVerificationRequired = true.
  const migrationReceipt = await runArchitectureChecks({
    cwd: project,
    baseSha: wave1Head,
    headSha: contractEditHead,
    config: { enabled: true },
    artifacts,
    taskPaths: ['crates/game-contracts/**'],
  });
  assert.equal(migrationReceipt.status, 'passed', `Migration failed: ${JSON.stringify(migrationReceipt.report)}`);
  assert.equal(migrationReceipt.passed, true);
  assert.equal(migrationReceipt.requiresReview, true);
  assert.equal(migrationReceipt.fullVerificationRequired, true);
});

test('W3: contract scope requires literal directory segments; crates/game-contracts*/** and crates/*/src/types.rs fail both gate and blueprint linter', async t => {
  // 1) Gate: globbed contract name and sibling wildcard must NOT authorize contract edits.
  const fx = await rustFixture(t);
  await fx.put('crates/game-contracts/src/lib.rs', 'pub struct Event { pub id: u64 }\n');
  const headSha = fx.commit('edit contract crate');

  for (const badScope of [
    'crates/game-contracts*/**',
    'crates/game-contracts*',
    'crates/*/src/lib.rs',
    'crates/{world,game-contracts}/**',
    '**/lib.rs',
  ]) {
    const res = await checkArchitecture({
      project: fx.project,
      baseSha: fx.baseSha,
      headSha,
      evidenceDir: fx.artifacts,
      taskPaths: [badScope],
    });
    assert.equal(res.status, 'failed', `badScope ${badScope} must fail gate`);
    assert.ok(
      res.findings.some(f => f.ruleId === 'contract_change_not_allowed'),
      `badScope ${badScope} must report contract_change_not_allowed, got ${JSON.stringify(res.findings)}`,
    );
  }

  for (const goodScope of ['crates/game-contracts/**', 'crates/game-contracts', 'crates/game-contracts/src/lib.rs']) {
    const res = await checkArchitecture({
      project: fx.project,
      baseSha: fx.baseSha,
      headSha,
      evidenceDir: fx.artifacts,
      taskPaths: [goodScope],
    });
    assert.equal(res.status, 'passed', `goodScope ${goodScope} must pass gate: ${JSON.stringify(res.findings)}`);
  }

  // 2) Blueprint linter: any glob intersecting contract subtree without naming it literally -> contract_scope_too_broad.
  const makeSpec = extraWritePath => ({
    schemaVersion: 1,
    id: 'w3-bp',
    title: 'Rust W3',
    root: '/tmp/w3',
    businessContext: 'Cargo workspace',
    execution: { cadence: 'wave', integration: 'branch' },
    constraints: [],
    milestones: [{ id: 'foundation', title: 'W0', acceptance: [] }],
    epics: [
      { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [] },
      { id: 'domain', milestoneId: 'foundation', title: 'Domain', acceptance: [] },
    ],
    tasks: [
      {
        id: 't0',
        epicId: 'foundation',
        title: 'Contracts',
        owner: 'architect',
        dependsOn: [],
        writePaths: [
          'Cargo.toml',
          'crates/game-contracts/Cargo.toml',
          'crates/game-contracts/src/**',
          'architecture.policy.json',
        ],
      },
      {
        id: 't1',
        epicId: 'domain',
        title: 'World',
        owner: 'developer',
        dependsOn: ['t0'],
        writePaths: [extraWritePath, 'crates/world/Cargo.toml', 'crates/world/src/**'],
      },
      {
        id: 't2',
        epicId: 'domain',
        title: 'Combat',
        owner: 'developer',
        dependsOn: ['t0'],
        writePaths: ['crates/combat/Cargo.toml', 'crates/combat/src/**'],
      },
    ],
  });

  for (const broad of [
    'crates/game-contracts*/**',
    'crates/game-contracts*',
    'crates/*/src/types.rs',
    'crates/{world,game-contracts}/**',
    '**/types.rs',
  ]) {
    const findings = rustContractCrateFindings(makeSpec(broad), '## Стек\nRust Cargo workspace\n');
    assert.ok(
      findings.some(f => f.code === 'contract_scope_too_broad' && f.taskIds?.includes('t1')),
      `expected contract_scope_too_broad for ${broad}, got ${JSON.stringify(findings)}`,
    );
  }

  // Non-intersecting glob on another crate must NOT trigger contract_scope_too_broad.
  const okFindings = rustContractCrateFindings(makeSpec('crates/world*/**'), '## Стек\nRust Cargo workspace\n');
  assert.equal(
    okFindings.some(f => f.code === 'contract_scope_too_broad'),
    false,
    `crates/world*/** must not trigger contract_scope_too_broad: ${JSON.stringify(okFindings)}`,
  );

  // Wave 0 using crates/game-contracts*/** must NOT satisfy contract_crate_required.
  const badW0Spec = makeSpec('crates/world/src/lib.rs');
  badW0Spec.tasks[0].writePaths = ['Cargo.toml', 'crates/game-contracts*/**', 'architecture.policy.json'];
  badW0Spec.tasks.push({
    id: 't3',
    epicId: 'domain',
    title: 'Render',
    owner: 'developer',
    dependsOn: ['t0'],
    writePaths: ['crates/render/Cargo.toml', 'crates/render/src/**'],
  });
  const badW0Findings = rustContractCrateFindings(badW0Spec, '## Стек\nRust Cargo workspace\n');
  assert.ok(
    badW0Findings.some(f => f.code === 'contract_crate_required'),
    `globbed Wave 0 path must not satisfy contract_crate_required: ${JSON.stringify(badW0Findings)}`,
  );
});

test('W2: Rust workspace >= 3 requires architecture.policy.json in Wave 0, orders other Wave 0 tasks after it, and counts root [package] separately from virtual root', () => {
  const mkSpec = (epics, tasks) => ({
    schemaVersion: 1,
    id: 'w2-bp',
    title: 'Rust W2',
    root: '/tmp/w2',
    businessContext: 'Cargo workspace',
    execution: { cadence: 'wave', integration: 'branch' },
    constraints: [],
    milestones: [{ id: 'foundation', title: 'W0', acceptance: [] }],
    epics,
    tasks,
  });
  const md = '## Стек\nRust Cargo workspace\n';

  // 1) Missing architecture.policy.json in Wave 0 -> architecture_policy_required.
  const noPolicy = mkSpec(
    [
      { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [] },
      { id: 'domain', milestoneId: 'foundation', title: 'Domain', acceptance: [] },
    ],
    [
      {
        id: 'w0',
        epicId: 'foundation',
        title: 'Contracts',
        owner: 'architect',
        dependsOn: [],
        writePaths: ['Cargo.toml', 'crates/game-contracts/Cargo.toml', 'crates/game-contracts/src/**'],
      },
      {
        id: 't1',
        epicId: 'domain',
        title: 'World',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['crates/world/Cargo.toml', 'crates/world/src/**'],
      },
      {
        id: 't2',
        epicId: 'domain',
        title: 'Combat',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['crates/combat/Cargo.toml', 'crates/combat/src/**'],
      },
    ],
  );
  const noPolicyFindings = rustContractCrateFindings(noPolicy, md);
  assert.ok(
    noPolicyFindings.some(f => f.code === 'architecture_policy_required'),
    `expected architecture_policy_required, got ${JSON.stringify(noPolicyFindings)}`,
  );

  // 2) Second Wave 0 task/epic NOT depending on policy task -> architecture_policy_order.
  const parallelW0 = mkSpec(
    [
      { id: 'foundation-core', milestoneId: 'foundation', title: 'W0 Core', acceptance: [] },
      { id: 'foundation-tools', milestoneId: 'foundation', title: 'W0 Tools', acceptance: [] },
      { id: 'domain', milestoneId: 'foundation', title: 'Domain', acceptance: [] },
    ],
    [
      {
        id: 'w0-policy',
        epicId: 'foundation-core',
        title: 'Contracts + Policy',
        owner: 'architect',
        dependsOn: [],
        writePaths: [
          'Cargo.toml',
          'crates/game-contracts/Cargo.toml',
          'crates/game-contracts/src/**',
          'architecture.policy.json',
        ],
      },
      {
        id: 'w0-lint',
        epicId: 'foundation-tools',
        title: 'Lint setup',
        owner: 'developer',
        dependsOn: [],
        writePaths: ['rustfmt.toml'],
      },
      {
        id: 't1',
        epicId: 'domain',
        title: 'World',
        owner: 'developer',
        dependsOn: ['w0-policy', 'w0-lint'],
        writePaths: ['crates/world/Cargo.toml', 'crates/world/src/**'],
      },
      {
        id: 't2',
        epicId: 'domain',
        title: 'Combat',
        owner: 'developer',
        dependsOn: ['w0-policy'],
        writePaths: ['crates/combat/Cargo.toml', 'crates/combat/src/**'],
      },
    ],
  );
  // Note: domain has milestoneId 'foundation' above — put domain in a separate milestone so only foundation-* are Wave 0.
  parallelW0.milestones.push({ id: 'mvp', title: 'MVP', acceptance: [] });
  parallelW0.epics[2].milestoneId = 'mvp';
  const orderFindings = rustContractCrateFindings(parallelW0, md);
  assert.ok(
    orderFindings.some(f => f.code === 'architecture_policy_order' && f.taskIds?.includes('w0-lint')),
    `expected architecture_policy_order for w0-lint, got ${JSON.stringify(orderFindings)}`,
  );

  // Once w0-lint depends on w0-policy, order is valid.
  parallelW0.tasks[1].dependsOn = ['w0-policy'];
  assert.deepEqual(rustContractCrateFindings(parallelW0, md), []);

  // 3) Root [package] (Cargo.toml + src/main.rs) + 2 nested crates = 3 members -> triggers contract_crate_required & architecture_policy_required.
  const rootPkgPlusTwo = mkSpec(
    [
      { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [] },
      { id: 'mvp', milestoneId: 'mvp', title: 'MVP', acceptance: [] },
    ],
    [
      {
        id: 'w0',
        epicId: 'foundation',
        title: 'Root app',
        owner: 'developer',
        dependsOn: [],
        writePaths: ['Cargo.toml', 'src/main.rs'],
      },
      {
        id: 't1',
        epicId: 'mvp',
        title: 'A',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['crates/a/Cargo.toml', 'crates/a/src/**'],
      },
      {
        id: 't2',
        epicId: 'mvp',
        title: 'B',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['crates/b/Cargo.toml', 'crates/b/src/**'],
      },
    ],
  );
  rootPkgPlusTwo.milestones.push({ id: 'mvp', title: 'MVP', acceptance: [] });
  const rootPkgFindings = rustContractCrateFindings(rootPkgPlusTwo, md);
  assert.ok(
    rootPkgFindings.some(f => f.code === 'contract_crate_required'),
    `root [package] + 2 crates must trigger contract_crate_required, got ${JSON.stringify(rootPkgFindings)}`,
  );
  assert.ok(
    rootPkgFindings.some(f => f.code === 'architecture_policy_required'),
    `root [package] + 2 crates must trigger architecture_policy_required, got ${JSON.stringify(rootPkgFindings)}`,
  );

  // 4) Virtual root (Cargo.toml without src/**) + 2 nested crates = 2 members -> does NOT trigger.
  const virtualRootPlusTwo = structuredClone(rootPkgPlusTwo);
  virtualRootPlusTwo.tasks[0].writePaths = ['Cargo.toml'];
  const virtualFindings = rustContractCrateFindings(virtualRootPlusTwo, md);
  assert.deepEqual(
    virtualFindings,
    [],
    `virtual root + 2 crates must not trigger contract/policy findings, got ${JSON.stringify(virtualFindings)}`,
  );
});

test('W4: include in .cargo/config(.toml) blocks fail-closed with unsupported-cargo-config-include pointing to source config', async t => {
  const fx = await rustFixture(t);
  await fx.put('.cargo/extra-patch.toml', '[patch.crates-io]\nserde = { path = "crates/render" }\n');
  await fx.put('.cargo/config.toml', 'include = ["extra-patch.toml"]\n');
  const head1 = fx.commit('add .cargo/config.toml with include');

  const res1 = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: head1,
    evidenceDir: fx.artifacts,
  });
  assert.equal(res1.status, 'blocked');
  assert.ok(
    res1.unsupported.some(u => u.reason === 'unsupported-cargo-config-include' && u.file === '.cargo/config.toml'),
    `expected unsupported-cargo-config-include on .cargo/config.toml, got ${JSON.stringify(res1.unsupported)}`,
  );

  // Nested .cargo/config with string include also blocks with its exact source path.
  await fx.put('crates/app/.cargo/config', 'include = "override.toml"\n');
  const head2 = fx.commit('add nested .cargo/config with include');
  const res2 = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: head2,
    evidenceDir: fx.artifacts,
  });
  assert.equal(res2.status, 'blocked');
  assert.ok(
    res2.unsupported.some(
      u => u.reason === 'unsupported-cargo-config-include' && u.file === 'crates/app/.cargo/config',
    ),
    `expected unsupported-cargo-config-include on crates/app/.cargo/config, got ${JSON.stringify(res2.unsupported)}`,
  );
});

test('W5: workspace member globs inspect snapshot directories (member-glob-no-match, member-without-manifest, exclude, sibling file)', async t => {
  const fx = await rustFixture(t);
  await fx.put('crates/readme/README.md', '# Notes\n');
  const headNoManifest = fx.commit('add crates/readme without Cargo.toml');
  const resNoManifest = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: headNoManifest,
    evidenceDir: fx.artifacts,
  });
  assert.equal(resNoManifest.status, 'blocked');
  assert.ok(
    resNoManifest.unsupported.some(
      u => u.reason === 'member-without-manifest' && u.file === 'crates/readme/Cargo.toml',
    ),
    `expected member-without-manifest for crates/readme, got ${JSON.stringify(resNoManifest.unsupported)}`,
  );

  await fx.put(
    'Cargo.toml',
    defaultWorkspaceFiles()['Cargo.toml'].replace(
      'members = ["crates/*"]',
      'members = ["crates/*"]\nexclude = ["crates/readme"]',
    ),
  );
  const headExcluded = fx.commit('exclude crates/readme');
  const resExcluded = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: headExcluded,
    evidenceDir: fx.artifacts,
  });
  assert.equal(resExcluded.status, 'passed', `excluded non-crate dir must pass: ${JSON.stringify(resExcluded)}`);

  await fx.put('crates/README.md', '# Workspace\n');
  const headSibling = fx.commit('add crates/README.md file');
  const resSibling = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: headSibling,
    evidenceDir: fx.artifacts,
  });
  assert.equal(resSibling.status, 'passed', `sibling file must pass: ${JSON.stringify(resSibling)}`);

  await fx.put(
    'Cargo.toml',
    defaultWorkspaceFiles()['Cargo.toml'].replace(
      'members = ["crates/*"]',
      'members = ["crates/*", "missing/*"]\nexclude = ["crates/readme"]',
    ),
  );
  const headNoMatch = fx.commit('add unmatched glob');
  const resNoMatch = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: headNoMatch,
    evidenceDir: fx.artifacts,
  });
  assert.equal(resNoMatch.status, 'blocked');
  assert.ok(
    resNoMatch.unsupported.some(u => u.reason === 'member-glob-no-match' && u.file === 'Cargo.toml'),
    `expected member-glob-no-match, got ${JSON.stringify(resNoMatch.unsupported)}`,
  );
});

test('W6: edition-aware dependency tables (hyphen precedence over underscore in <2024; underscore blocked in >=2024 including edition.workspace=true and target.*)', async t => {
  // 1) Edition 2021 with BOTH [dev-dependencies] and [dev_dependencies]: Cargo uses hyphen only -> no bogus edge/layer violation.
  const fx2021 = await rustFixture(t);
  await fx2021.put(
    'crates/core/Cargo.toml',
    [
      '[package]',
      'name = "core"',
      'version = "0.1.0"',
      'edition = "2021"',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      '[dev-dependencies]',
      'proptest = { workspace = true }',
      '[dev_dependencies]',
      'app = { path = "../app" }',
      "[target.'cfg(unix)'.build-dependencies]",
      'serde = { workspace = true }',
      "[target.'cfg(unix)'.build_dependencies]",
      'render = { path = "../render" }',
    ].join('\n') + '\n',
  );
  const head2021 = fx2021.commit('edition 2021 hyphen precedence');
  const res2021 = await checkArchitecture({
    project: fx2021.project,
    baseSha: fx2021.baseSha,
    headSha: head2021,
    evidenceDir: fx2021.artifacts,
  });
  assert.equal(
    res2021.status,
    'passed',
    `hyphen precedence in 2021 must not read underscore tables: ${JSON.stringify(res2021)}`,
  );

  // 2) Edition 2024 (direct or via edition.workspace = true) with underscore table -> blocked with unsupported-underscore-dependencies.
  const fx2024 = await rustFixture(t);
  await fx2024.put(
    'crates/core/Cargo.toml',
    [
      '[package]',
      'name = "core"',
      'version = "0.1.0"',
      'edition = "2024"',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      '[dev_dependencies]',
      'proptest = { workspace = true }',
    ].join('\n') + '\n',
  );
  const head2024 = fx2024.commit('edition 2024 underscore dev_dependencies');
  const res2024 = await checkArchitecture({
    project: fx2024.project,
    baseSha: fx2024.baseSha,
    headSha: head2024,
    evidenceDir: fx2024.artifacts,
  });
  assert.equal(res2024.status, 'blocked');
  assert.ok(
    res2024.unsupported.some(
      u => u.reason === 'unsupported-underscore-dependencies' && u.file === 'crates/core/Cargo.toml',
    ),
    `expected unsupported-underscore-dependencies in edition 2024, got ${JSON.stringify(res2024.unsupported)}`,
  );

  // 3) Inherited edition.workspace = true -> 2024 also blocks target.* build_dependencies.
  await fx2024.put('Cargo.toml', `${defaultWorkspaceFiles()['Cargo.toml']}\n[workspace.package]\nedition = "2024"\n`);
  await fx2024.put(
    'crates/core/Cargo.toml',
    [
      '[package]',
      'name = "core"',
      'version = "0.1.0"',
      'edition.workspace = true',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      "[target.'cfg(unix)'.build_dependencies]",
      'serde = { workspace = true }',
    ].join('\n') + '\n',
  );
  const headWs2024 = fx2024.commit('workspace edition 2024 target build_dependencies');
  const resWs2024 = await checkArchitecture({
    project: fx2024.project,
    baseSha: fx2024.baseSha,
    headSha: headWs2024,
    evidenceDir: fx2024.artifacts,
  });
  assert.equal(resWs2024.status, 'blocked');
  assert.ok(
    resWs2024.unsupported.some(
      u => u.reason === 'unsupported-underscore-dependencies' && u.file === 'crates/core/Cargo.toml',
    ),
    `expected unsupported-underscore-dependencies for inherited edition 2024, got ${JSON.stringify(resWs2024.unsupported)}`,
  );
});

test('W7: path dep to package under nested [workspace] becomes root member while nested root itself conflicts; startDir checks membership and exclude', async t => {
  const fx = await rustFixture(t);
  await fx.put('nested/Cargo.toml', '[workspace]\nresolver = "2"\nmembers = ["other"]\n');
  await fx.put('nested/other/Cargo.toml', '[package]\nname = "other"\nversion = "0.1.0"\nedition = "2021"\n');
  await fx.put('nested/other/src/lib.rs', 'pub fn other() {}\n');
  await fx.put('nested/b/Cargo.toml', '[package]\nname = "nested-b"\nversion = "0.1.0"\nedition = "2021"\n');
  await fx.put('nested/b/src/lib.rs', 'pub fn b() {}\n');
  await fx.put(
    'crates/app/Cargo.toml',
    [
      '[package]',
      'name = "app"',
      'version = "0.1.0"',
      'edition = "2024"',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'render = { path = "../render" }',
      'nested-b = { path = "../../nested/b" }',
    ].join('\n') + '\n',
  );
  const headUnder = fx.commit('path dep into package under nested workspace');
  const resUnder = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: headUnder,
    evidenceDir: fx.artifacts,
  });
  // nested-b is now a real root workspace member (no nested-workspace-root error),
  // and because it is not listed in layers, the gate catches ownership.unowned for nested/b/Cargo.toml!
  assert.deepEqual(resUnder.unsupported, []);
  assert.equal(resUnder.status, 'failed');
  assert.ok(
    resUnder.findings.some(f => f.ruleId === 'ownership.unowned' && f.file === 'nested/b/Cargo.toml'),
    `expected ownership.unowned for nested-b member, got ${JSON.stringify(resUnder.findings)}`,
  );

  // Path dep pointing to the nested [workspace] root itself MUST fail with nested-workspace-root.
  await fx.put(
    'nested/Cargo.toml',
    '[package]\nname = "nested-root"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n',
  );
  await fx.put('nested/src/lib.rs', 'pub fn root() {}\n');
  await fx.put(
    'crates/app/Cargo.toml',
    [
      '[package]',
      'name = "app"',
      'version = "0.1.0"',
      'edition = "2024"',
      '[dependencies]',
      'game-contracts = { workspace = true }',
      'render = { path = "../render" }',
      'nested-root = { path = "../../nested" }',
    ].join('\n') + '\n',
  );
  const headRoot = fx.commit('path dep to nested workspace root itself');
  const resRoot = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha: headRoot,
    evidenceDir: fx.artifacts,
  });
  assert.equal(resRoot.status, 'blocked');
  assert.ok(
    resRoot.unsupported.some(u => u.reason === 'nested-workspace-root' && u.file === 'nested/Cargo.toml'),
    `expected nested-workspace-root on nested/Cargo.toml, got ${JSON.stringify(resRoot.unsupported)}`,
  );
});

test('W8: blueprint declarations ignore code fences and prose like "No Cargo workspace", scope contracts per workspace, and verify against existing policy v2 contractCrates', () => {
  const mkSpec = (tasks, constraints = []) => ({
    schemaVersion: 1,
    id: 'w8-bp',
    title: 'Rust W8',
    root: '/tmp/w8',
    businessContext: 'Rust project',
    execution: { cadence: 'wave', integration: 'branch' },
    constraints,
    milestones: [
      { id: 'foundation', title: 'W0', acceptance: [] },
      { id: 'mvp', title: 'MVP', acceptance: [] },
    ],
    epics: [
      { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [] },
      { id: 'domain', milestoneId: 'mvp', title: 'Domain', acceptance: [] },
    ],
    tasks,
  });

  // 1) contractCrate inside Markdown code fence is ignored -> contract_crate_required.
  const protoSpec = mkSpec([
    {
      id: 'w0',
      epicId: 'foundation',
      title: 'Protocol',
      owner: 'architect',
      dependsOn: [],
      writePaths: ['Cargo.toml', 'architecture.policy.json', 'crates/protocol/Cargo.toml', 'crates/protocol/src/**'],
    },
    {
      id: 't1',
      epicId: 'domain',
      title: 'A',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['crates/a/Cargo.toml', 'crates/a/src/**'],
    },
    {
      id: 't2',
      epicId: 'domain',
      title: 'B',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['crates/b/Cargo.toml', 'crates/b/src/**'],
    },
  ]);
  const fencedMd = '## Стек\nRust\n```yaml\ncontractCrate: crates/protocol\n```\n';
  const fencedFindings = rustContractCrateFindings(protoSpec, fencedMd);
  assert.ok(
    fencedFindings.some(f => f.code === 'contract_crate_required'),
    `fenced contractCrate must be ignored, got ${JSON.stringify(fencedFindings)}`,
  );
  // Outside code fence with canonical `contractCrate: crates/protocol` -> PASS.
  const outsideMd = '## Стек\nRust\ncontractCrate: crates/protocol\n';
  assert.deepEqual(rustContractCrateFindings(protoSpec, outsideMd), []);

  // 2) Prose "No Cargo workspace" must NOT fabricate a shared root workspace for independent CLIs.
  const noWsSpec = mkSpec(
    [
      {
        id: 'w0',
        epicId: 'foundation',
        title: 'Scripts',
        owner: 'architect',
        dependsOn: [],
        writePaths: ['scripts/ci.mjs'],
      },
      {
        id: 't1',
        epicId: 'domain',
        title: 'Lint',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['tools/lint/Cargo.toml', 'tools/lint/src/**'],
      },
      {
        id: 't2',
        epicId: 'domain',
        title: 'Fmt',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['tools/fmt/Cargo.toml', 'tools/fmt/src/**'],
      },
      {
        id: 't3',
        epicId: 'domain',
        title: 'Gen',
        owner: 'developer',
        dependsOn: ['w0'],
        writePaths: ['tools/gen/Cargo.toml', 'tools/gen/src/**'],
      },
    ],
    ['No Cargo workspace — standalone tools'],
  );
  const noWsFindings = rustContractCrateFindings(noWsSpec, '## Стек\nRust (No Cargo workspace)\n');
  assert.deepEqual(
    noWsFindings,
    [],
    `prose "No Cargo workspace" must not create a workspace: ${JSON.stringify(noWsFindings)}`,
  );

  // 3) Two workspaces: contract in ws-a does NOT satisfy ws-b.
  const twoWsSpec = mkSpec([
    {
      id: 'w0',
      epicId: 'foundation',
      title: 'WS A contracts',
      owner: 'architect',
      dependsOn: [],
      writePaths: [
        'architecture.policy.json',
        'ws-a/Cargo.toml',
        'ws-a/crates/a-contracts/Cargo.toml',
        'ws-a/crates/a-contracts/src/**',
        'ws-b/Cargo.toml',
      ],
    },
    {
      id: 'a1',
      epicId: 'domain',
      title: 'A1',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['ws-a/crates/a1/Cargo.toml', 'ws-a/crates/a1/src/**'],
    },
    {
      id: 'a2',
      epicId: 'domain',
      title: 'A2',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['ws-a/crates/a2/Cargo.toml', 'ws-a/crates/a2/src/**'],
    },
    {
      id: 'b1',
      epicId: 'domain',
      title: 'B1',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['ws-b/crates/b1/Cargo.toml', 'ws-b/crates/b1/src/**'],
    },
    {
      id: 'b2',
      epicId: 'domain',
      title: 'B2',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['ws-b/crates/b2/Cargo.toml', 'ws-b/crates/b2/src/**'],
    },
    {
      id: 'b3',
      epicId: 'domain',
      title: 'B3',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['ws-b/crates/b3/Cargo.toml', 'ws-b/crates/b3/src/**'],
    },
  ]);
  const twoWsFindings = rustContractCrateFindings(twoWsSpec, '## Стек\nRust\ncontractCrate: ws-a/crates/a-contracts\n');
  assert.ok(
    twoWsFindings.some(f => f.code === 'contract_crate_required'),
    `ws-a contract must not satisfy ws-b, got ${JSON.stringify(twoWsFindings)}`,
  );

  // 4) Existing v2 architecture policy is authoritative: contractCrate not in policy.contractCrates must NOT pass.
  const mismatchPolicy = {
    schemaVersion: 2,
    language: 'rust',
    contractCrates: ['other-contracts'],
  };
  const mismatchFindings = rustContractCrateFindings(protoSpec, outsideMd, mismatchPolicy);
  assert.ok(
    mismatchFindings.some(f => f.code === 'contract_crate_required'),
    `contractCrate not listed in existing policy.contractCrates must fail, got ${JSON.stringify(mismatchFindings)}`,
  );

  const matchingPolicy = {
    schemaVersion: 2,
    language: 'rust',
    contractCrates: ['protocol'],
  };
  assert.deepEqual(rustContractCrateFindings(protoSpec, outsideMd, matchingPolicy), []);
});

test('W9: architectureTaskPathsForRun is shared, gate error surfaces snapshot (base/head) and hint for unsupported', async t => {
  const gateMod = await import('../runtime/architecture-gate.mjs');
  assert.equal(typeof gateMod.architectureTaskPathsForRun, 'function');
  assert.deepEqual(gateMod.architectureTaskPathsForRun(null), []);
  assert.deepEqual(gateMod.architectureTaskPathsForRun({ plan: { tasks: [{ writePaths: ['a'] }, {}] } }), ['a']);

  // Verify snapshot ('head' and 'base') and hint in Engine gate failure findings.
  const efx = await engineFixture(t, {
    config: { architecture: { enabled: true }, repairRounds: 1, researchBudget: 0, concurrency: 1 },
    testScript: 'process.exit(0);\n',
  });
  const engine = new Engine({ store: efx.openStore(), ...fakeServices() });
  const run = await engine.create('W9 unsupported diagnostics', {
    project: efx.project,
    mode: 'quick',
    model: 'gpt-6.1-sol',
  });
  await engine.prepare(run);
  run.models = await engine.provider.discoverProviders();
  run.plan = {
    summary: 'Add patch config',
    tasks: [
      planNode('w9', 'developer', [
        'Cargo.toml',
        'crates/game-contracts/**',
        'architecture.policy.json',
        '.cargo/config.toml',
      ]),
    ],
  };
  const put = async (rel, content) => {
    const full = path.join(run.cwd, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  };
  await put('Cargo.toml', '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n');
  await put(
    'crates/game-contracts/Cargo.toml',
    '[package]\nname = "game-contracts"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  await put('crates/game-contracts/src/lib.rs', 'pub struct Id(pub u64);\n');
  await put('architecture.policy.json', {
    schemaVersion: 2,
    version: 1,
    language: 'rust',
    productRoots: ['crates'],
    layers: [{ id: 'contracts', crates: ['game-contracts'] }],
    cycles: 'forbid',
    allowedExternalCrates: [],
    allowedDevExternalCrates: [],
    contractCrates: ['game-contracts'],
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json'],
  });
  await put('.cargo/config.toml', 'include = ["extra.toml"]\n');
  fixtureGit(run.cwd, 'add', '-A');
  fixtureGit(run.cwd, 'commit', '-m', 'add workspace with include config');

  await engine.checks(run);
  await assert.rejects(engine.verificationGates(run), err => {
    assert.equal(err.code, 'verification_failed');
    const failures = JSON.parse(err.message.slice(err.message.indexOf('[')));
    const finding = failures
      .flatMap(entry => entry.findings || [])
      .find(row => row.ruleId === 'unsupported.unsupported-cargo-config-include');
    assert.ok(finding, `expected unsupported.unsupported-cargo-config-include in ${err.message}`);
    assert.equal(finding.snapshot, 'head');
    assert.equal(typeof finding.hint, 'string');
    assert.ok(finding.hint.length > 10, `expected non-empty hint, got ${JSON.stringify(finding)}`);
    return true;
  });

  // Also verify snapshot === 'base' when unsupported construct exists on base commit.
  const baseWithInclude = fixtureGit(run.cwd, 'rev-parse', 'HEAD');
  await rm(path.join(run.cwd, '.cargo/config.toml'));
  fixtureGit(run.cwd, 'add', '-A');
  fixtureGit(run.cwd, 'commit', '-m', 'remove include config on head');
  const headClean = fixtureGit(run.cwd, 'rev-parse', 'HEAD');
  const baseRes = await checkArchitecture({
    project: run.cwd,
    baseSha: baseWithInclude,
    headSha: headClean,
    evidenceDir: run.artifacts,
  });
  assert.equal(baseRes.status, 'blocked');
  assert.ok(
    baseRes.unsupported.some(
      u => u.reason === 'unsupported-cargo-config-include' && u.snapshot === 'base' && u.file === '.cargo/config.toml',
    ),
    `expected snapshot="base" on base unsupported, got ${JSON.stringify(baseRes.unsupported)}`,
  );
});

test('X5: members = ["*"] excludes workspace root itself while root [package] is added separately; explicit package.workspace resolves before ancestor search', async () => {
  const mod = await import('../runtime/cargo-workspace.mjs');
  const virtualStar = mod.resolveCargoWorkspace({
    manifests: {
      'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["*"]\n',
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
      'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n',
    },
    files: ['Cargo.toml', 'a/Cargo.toml', 'a/src/lib.rs', 'b/Cargo.toml', 'b/src/lib.rs'],
  });
  assert.deepEqual(virtualStar.unsupported, []);
  assert.deepEqual(
    virtualStar.members.map(m => m.name),
    ['a', 'b'],
  );

  const rootPkgStar = mod.resolveCargoWorkspace({
    manifests: {
      'Cargo.toml':
        '[package]\nname = "root-pkg"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\nresolver = "2"\nmembers = ["*"]\nexclude = ["src"]\n',
      'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
    },
    files: ['Cargo.toml', 'src/lib.rs', 'a/Cargo.toml', 'a/src/lib.rs'],
  });
  assert.deepEqual(rootPkgStar.unsupported, []);
  assert.deepEqual(
    rootPkgStar.members.map(m => m.name),
    ['root-pkg', 'a'],
  );

  // Explicit package.workspace = "../.." bypasses intermediate nested [workspace].
  const explicitWs = mod.resolveCargoWorkspace({
    manifests: {
      'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["nested/sub", "peer"]\n',
      'peer/Cargo.toml': '[package]\nname = "peer"\nversion = "0.1.0"\nedition = "2021"\n',
      'nested/Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["other"]\n',
      'nested/other/Cargo.toml': '[package]\nname = "other"\nversion = "0.1.0"\nedition = "2021"\n',
      'nested/sub/Cargo.toml': '[package]\nname = "sub"\nversion = "0.1.0"\nedition = "2021"\nworkspace = "../.."\n',
    },
    startDir: 'nested/sub',
  });
  assert.deepEqual(explicitWs.unsupported, []);
  assert.equal(explicitWs.root, '');
  assert.deepEqual(
    explicitWs.members.map(m => m.name),
    ['sub', 'peer'],
  );
});

test('X4: hidden files (.gitignore, .cargo/config.toml) inside contract crate are allowed by crates/<contract>/** matching ownsPath semantics', async t => {
  const fx = await rustFixture(t);
  await fx.put('crates/game-contracts/.gitignore', 'target/\n');
  await fx.put('crates/game-contracts/.cargo/config.toml', '[build]\njobs = 2\n');
  const headSha = fx.commit('add dotfiles inside contract crate');

  // Explicit contract directory glob dir/** must authorize dotfiles inside the contract crate.
  const allowed = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha,
    evidenceDir: fx.artifacts,
    taskPaths: ['crates/game-contracts/**'],
  });
  assert.equal(allowed.status, 'passed', `dotfiles must be allowed by dir/**: ${JSON.stringify(allowed.findings)}`);
  assert.equal(allowed.requiresReview, true);

  // Unrelated taskPaths must still block both dotfiles.
  const deniedOther = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha,
    evidenceDir: fx.artifacts,
    taskPaths: ['crates/world/**'],
  });
  assert.equal(deniedOther.status, 'failed');
  assert.ok(
    deniedOther.findings.some(
      f => f.ruleId === 'contract_change_not_allowed' && f.file === 'crates/game-contracts/.gitignore',
    ),
  );
  assert.ok(
    deniedOther.findings.some(
      f => f.ruleId === 'contract_change_not_allowed' && f.file === 'crates/game-contracts/.cargo/config.toml',
    ),
  );

  // Narrower subtree crates/game-contracts/src/** must NOT authorize root dotfiles.
  const deniedNarrow = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha,
    evidenceDir: fx.artifacts,
    taskPaths: ['crates/game-contracts/src/**'],
  });
  assert.equal(deniedNarrow.status, 'failed');
  assert.ok(
    deniedNarrow.findings.some(
      f => f.ruleId === 'contract_change_not_allowed' && f.file === 'crates/game-contracts/.gitignore',
    ),
  );
});

test('X1: brace-expanded globs like {crates/game-contracts,crates/world}/src/** fail linter & gate; epic gate checks contract edits per task diff', async t => {
  const fx = await rustFixture(t);
  await fx.put('crates/game-contracts/src/lib.rs', 'pub struct Event { pub id: u128 }\n');
  const headSha = fx.commit('edit contract crate for X1');

  // 1) Gate: brace alternation before contract crate root must NOT authorize contract edits.
  for (const badScope of [
    '{crates/game-contracts,crates/world}/src/**',
    '{crates/game-contracts*,crates/world}/**',
    'crates/{game-contracts,world}/src/**',
    '{crates/game-contracts}/src/**',
  ]) {
    const res = await checkArchitecture({
      project: fx.project,
      baseSha: fx.baseSha,
      headSha,
      evidenceDir: fx.artifacts,
      taskPaths: [badScope],
    });
    assert.equal(res.status, 'failed', `badScope ${badScope} must fail gate`);
    assert.ok(
      res.findings.some(f => f.ruleId === 'contract_change_not_allowed'),
      `badScope ${badScope} must trigger contract_change_not_allowed, got ${JSON.stringify(res.findings)}`,
    );
  }

  // Brace alternation AFTER literal contract crate root IS explicit and authorizes matching files.
  const goodBrace = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    headSha,
    evidenceDir: fx.artifacts,
    taskPaths: ['crates/game-contracts/{src,tests}/**'],
  });
  assert.equal(
    goodBrace.status,
    'passed',
    `crates/game-contracts/{src,tests}/** must pass: ${JSON.stringify(goodBrace.findings)}`,
  );

  // 2) Blueprint linter: brace alternation intersecting contract crate -> contract_scope_too_broad.
  const mkSpec = extraScope => ({
    schemaVersion: 1,
    id: 'x1-bp',
    title: 'Rust X1',
    root: '/tmp/x1',
    businessContext: 'Cargo workspace',
    execution: { cadence: 'wave', integration: 'branch' },
    constraints: [],
    milestones: [
      { id: 'foundation', title: 'W0', acceptance: [] },
      { id: 'mvp', title: 'MVP', acceptance: [] },
    ],
    epics: [
      { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [] },
      { id: 'domain', milestoneId: 'mvp', title: 'Domain', acceptance: [] },
    ],
    tasks: [
      {
        id: 't0',
        epicId: 'foundation',
        title: 'Contracts',
        owner: 'architect',
        dependsOn: [],
        writePaths: [
          'Cargo.toml',
          'crates/game-contracts/Cargo.toml',
          'crates/game-contracts/src/**',
          'architecture.policy.json',
        ],
      },
      {
        id: 't1',
        epicId: 'domain',
        title: 'World',
        owner: 'developer',
        dependsOn: ['t0'],
        writePaths: [extraScope],
      },
      {
        id: 't2',
        epicId: 'domain',
        title: 'Combat',
        owner: 'developer',
        dependsOn: ['t0'],
        writePaths: ['crates/combat/Cargo.toml', 'crates/combat/src/**'],
      },
    ],
  });
  const md = '## Стек\nRust Cargo workspace\n';
  for (const broad of [
    '{crates/game-contracts,crates/world}/src/**',
    '{crates/game-contracts*,crates/world}/**',
    'crates/{game-contracts,world}/src/**',
    '{crates/game-contracts}/src/**',
  ]) {
    const findings = rustContractCrateFindings(mkSpec(broad), md);
    assert.ok(
      findings.some(f => f.code === 'contract_scope_too_broad' && f.taskIds?.includes('t1')),
      `expected contract_scope_too_broad for ${broad}, got ${JSON.stringify(findings)}`,
    );
  }
  // Unrelated brace alternation must NOT falsely trigger contract_scope_too_broad.
  assert.equal(
    rustContractCrateFindings(mkSpec('{crates/world,crates/render}/src/**'), md).some(
      f => f.code === 'contract_scope_too_broad',
    ),
    false,
  );
  // Explicit contract crate root with brace alternation inside is NOT broad.
  assert.equal(
    rustContractCrateFindings(mkSpec('crates/game-contracts/{src,tests}/**'), md).some(
      f => f.code === 'contract_scope_too_broad',
    ),
    false,
  );

  // 3) Epic gate: sibling migration task's authorization must NOT hide an unauthorized contract edit in another task.
  const epicFx = await rustFixture(t);
  await epicFx.put('crates/game-contracts/src/types.rs', 'pub struct EventId(pub u64);\n');
  const migrateCommit = epicFx.commit('task migrate-contracts');
  await epicFx.put('crates/world/src/lib.rs', 'pub fn tick() -> u64 { 1 }\n');
  await epicFx.put('crates/game-contracts/src/lib.rs', 'pub struct SneakyEdit;\n');
  const sneakyWorldCommit = epicFx.commit('task world-feature sneaks contract edit');

  const gateMod = await import('../runtime/architecture-gate.mjs');
  const epicRunBad = {
    planSource: 'gate',
    plan: {
      tasks: [
        { id: 'migrate-contracts', writePaths: ['crates/game-contracts/**'] },
        { id: 'world-feature', writePaths: ['crates/world/**'] },
      ],
    },
    nodes: {
      'migrate-contracts': { id: 'migrate-contracts', headSha: migrateCommit },
      'world-feature': { id: 'world-feature', headSha: sneakyWorldCommit },
    },
  };
  const badReceipt = await runArchitectureChecks({
    cwd: epicFx.project,
    baseSha: epicFx.baseSha,
    headSha: sneakyWorldCommit,
    config: { enabled: true },
    artifacts: epicFx.artifacts,
    taskPaths: gateMod.architectureTaskPathsForRun(epicRunBad),
    taskScopes: gateMod.architectureTaskScopesForRun(epicRunBad),
  });
  assert.equal(badReceipt.status, 'failed');
  assert.ok(
    badReceipt.report.findings.some(
      f => f.ruleId === 'contract_change_not_allowed' && f.file === 'crates/game-contracts/src/lib.rs',
    ),
    `sibling contract task must not hide unauthorized edit in world-feature: ${JSON.stringify(badReceipt.report.findings)}`,
  );

  // Clean epic: migrate-contracts edits contract, world-feature edits only world -> PASS + fresh receipt.
  const cleanFx = await rustFixture(t);
  await cleanFx.put('crates/game-contracts/src/lib.rs', 'pub struct CleanV2;\n');
  const cleanMigrate = cleanFx.commit('task migrate-contracts clean');
  await cleanFx.put('crates/world/src/lib.rs', 'pub fn tick() -> u64 { 2 }\n');
  const cleanWorld = cleanFx.commit('task world-feature clean');
  const epicRunClean = {
    planSource: 'gate',
    plan: {
      tasks: [
        { id: 'migrate-contracts', writePaths: ['crates/game-contracts/**'] },
        { id: 'world-feature', writePaths: ['crates/world/**'] },
      ],
    },
    nodes: {
      'migrate-contracts': { id: 'migrate-contracts', headSha: cleanMigrate },
      'world-feature': { id: 'world-feature', headSha: cleanWorld },
    },
  };
  const cleanOpts = {
    cwd: cleanFx.project,
    baseSha: cleanFx.baseSha,
    headSha: cleanWorld,
    config: { enabled: true },
    artifacts: cleanFx.artifacts,
    taskPaths: gateMod.architectureTaskPathsForRun(epicRunClean),
    taskScopes: gateMod.architectureTaskScopesForRun(epicRunClean),
  };
  const cleanReceipt = await runArchitectureChecks(cleanOpts);
  assert.equal(cleanReceipt.status, 'passed', `clean epic must pass: ${JSON.stringify(cleanReceipt.report)}`);
  assert.equal(await isCurrentArchitectureReceipt(cleanReceipt, cleanOpts), true);
  // Changing expected taskScopes must invalidate freshness.
  assert.equal(
    await isCurrentArchitectureReceipt(cleanReceipt, {
      ...cleanOpts,
      taskScopes: [{ id: 'world-feature', commit: cleanWorld, writePaths: ['crates/world/**'] }],
    }),
    false,
  );
});

test('X2: nested virtual workspace root is not a package, non-Rust src/** is not a root [package], indented code blocks & unpaired quotes are ignored, and Wave 0 policy epic requires manifest + contract', () => {
  const mkSpec = (epics, tasks) => ({
    schemaVersion: 1,
    id: 'x2-bp',
    title: 'Rust X2',
    root: '/tmp/x2',
    businessContext: 'Rust project',
    execution: { cadence: 'wave', integration: 'branch' },
    constraints: [],
    milestones: [
      { id: 'foundation', title: 'W0', acceptance: [] },
      { id: 'mvp', title: 'MVP', acceptance: [] },
    ],
    epics,
    tasks,
  });
  const stdEpics = [
    { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [] },
    { id: 'domain', milestoneId: 'mvp', title: 'Domain', acceptance: [] },
  ];
  const md = '## Стек\nRust Cargo workspace\n';

  // 1) Nested virtual workspace backend/Cargo.toml + 2 crates = 2 packages -> NO contract_crate_required / architecture_policy_required.
  const nestedVirtual = mkSpec(stdEpics, [
    {
      id: 'w0',
      epicId: 'foundation',
      title: 'Workspace',
      owner: 'architect',
      dependsOn: [],
      writePaths: ['backend/Cargo.toml'],
    },
    {
      id: 't1',
      epicId: 'domain',
      title: 'A',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['backend/crates/a/Cargo.toml', 'backend/crates/a/src/**'],
    },
    {
      id: 't2',
      epicId: 'domain',
      title: 'B',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['backend/crates/b/Cargo.toml', 'backend/crates/b/src/**'],
    },
  ]);
  assert.deepEqual(
    rustContractCrateFindings(nestedVirtual, md),
    [],
    `nested virtual workspace with 2 crates must not trigger: ${JSON.stringify(rustContractCrateFindings(nestedVirtual, md))}`,
  );

  // Nested root WITH backend/src/main.rs + 2 crates = 3 packages -> DOES trigger.
  const nestedRootPkg = structuredClone(nestedVirtual);
  nestedRootPkg.tasks[0].writePaths = ['backend/Cargo.toml', 'backend/src/main.rs'];
  const nestedRootFindings = rustContractCrateFindings(nestedRootPkg, md);
  assert.ok(nestedRootFindings.some(f => f.code === 'contract_crate_required'));
  assert.ok(nestedRootFindings.some(f => f.code === 'architecture_policy_required'));

  // 2) Polyglot frontend (package.json + src/**) with root Cargo.toml + 2 Rust crates = 2 Rust packages -> NO trigger.
  const polyglotFrontend = mkSpec(stdEpics, [
    {
      id: 'w0',
      epicId: 'foundation',
      title: 'Frontend + Workspace',
      owner: 'architect',
      dependsOn: [],
      writePaths: ['package.json', 'src/**', 'Cargo.toml'],
    },
    {
      id: 't1',
      epicId: 'domain',
      title: 'A',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['crates/a/Cargo.toml', 'crates/a/src/**'],
    },
    {
      id: 't2',
      epicId: 'domain',
      title: 'B',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['crates/b/Cargo.toml', 'crates/b/src/**'],
    },
  ]);
  assert.deepEqual(
    rustContractCrateFindings(polyglotFrontend, md),
    [],
    `frontend src/** must not count as Rust root [package]: ${JSON.stringify(rustContractCrateFindings(polyglotFrontend, md))}`,
  );

  // Explicit src/**/*.rs or rootPackage: . DOES count as Rust root [package] (3 total -> triggers).
  const rootRsGlob = structuredClone(polyglotFrontend);
  rootRsGlob.tasks[0].writePaths = ['Cargo.toml', 'src/**/*.rs'];
  assert.ok(rustContractCrateFindings(rootRsGlob, md).some(f => f.code === 'contract_crate_required'));
  assert.ok(
    rustContractCrateFindings(polyglotFrontend, `${md}rootPackage: .\n`).some(
      f => f.code === 'contract_crate_required',
    ),
  );

  // 3) Indented code block (4 spaces) and unpaired quotes/backticks must be ignored.
  const protoSpec = mkSpec(stdEpics, [
    {
      id: 'w0',
      epicId: 'foundation',
      title: 'Protocol',
      owner: 'architect',
      dependsOn: [],
      writePaths: ['Cargo.toml', 'architecture.policy.json', 'crates/protocol/Cargo.toml', 'crates/protocol/src/**'],
    },
    {
      id: 't1',
      epicId: 'domain',
      title: 'A',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['crates/a/Cargo.toml', 'crates/a/src/**'],
    },
    {
      id: 't2',
      epicId: 'domain',
      title: 'B',
      owner: 'developer',
      dependsOn: ['w0'],
      writePaths: ['crates/b/Cargo.toml', 'crates/b/src/**'],
    },
  ]);
  for (const badDecl of [
    '    contractCrate: crates/protocol\n',
    '\tcontractCrate: crates/protocol\n',
    'contractCrate: `crates/protocol\n',
    'contractCrate: crates/protocol`\n',
    'contractCrate: "crates/protocol\'\n',
  ]) {
    assert.ok(
      rustContractCrateFindings(protoSpec, `${md}${badDecl}`).some(f => f.code === 'contract_crate_required'),
      `invalid/indented declaration ${JSON.stringify(badDecl)} must be ignored`,
    );
  }
  for (const goodDecl of [
    'contractCrate: `crates/protocol`\n',
    'contractCrate: "crates/protocol"\n',
    "contractCrate: 'crates/protocol'\n",
    '  - contractCrate: crates/protocol\n',
  ]) {
    assert.deepEqual(
      rustContractCrateFindings(protoSpec, `${md}${goodDecl}`),
      [],
      `valid declaration ${JSON.stringify(goodDecl)} must pass`,
    );
  }

  // 4) Policy and contract in DIFFERENT Wave 0 epics: policy epic running before contract epic -> architecture_policy_order.
  const splitWave0 = mkSpec(
    [
      { id: 'foundation-policy', milestoneId: 'foundation', title: 'W0 Policy', acceptance: [] },
      { id: 'foundation-contracts', milestoneId: 'foundation', title: 'W0 Contracts', acceptance: [] },
      { id: 'domain', milestoneId: 'mvp', title: 'Domain', acceptance: [] },
    ],
    [
      {
        id: 'w0-policy',
        epicId: 'foundation-policy',
        title: 'Policy only',
        owner: 'architect',
        dependsOn: [],
        writePaths: ['architecture.policy.json'],
      },
      {
        id: 'w0-contracts',
        epicId: 'foundation-contracts',
        title: 'Contracts after policy epic',
        owner: 'architect',
        dependsOn: ['w0-policy'],
        writePaths: ['Cargo.toml', 'crates/game-contracts/Cargo.toml', 'crates/game-contracts/src/**'],
      },
      {
        id: 't1',
        epicId: 'domain',
        title: 'A',
        owner: 'developer',
        dependsOn: ['w0-contracts'],
        writePaths: ['crates/a/Cargo.toml', 'crates/a/src/**'],
      },
      {
        id: 't2',
        epicId: 'domain',
        title: 'B',
        owner: 'developer',
        dependsOn: ['w0-contracts'],
        writePaths: ['crates/b/Cargo.toml', 'crates/b/src/**'],
      },
    ],
  );
  const splitFindings = rustContractCrateFindings(splitWave0, md);
  assert.ok(
    splitFindings.some(f => f.code === 'architecture_policy_order' && f.taskIds?.includes('w0-policy')),
    `policy epic without manifest/contract ready must trigger architecture_policy_order, got ${JSON.stringify(splitFindings)}`,
  );

  // Same epic (contracts then policy in one Wave 0 epic) -> PASS because both exist at that epic's gate.
  const sameEpicWave0 = mkSpec(stdEpics, [
    {
      id: 'w0-contracts',
      epicId: 'foundation',
      title: 'Contracts',
      owner: 'architect',
      dependsOn: [],
      writePaths: ['Cargo.toml', 'crates/game-contracts/Cargo.toml', 'crates/game-contracts/src/**'],
    },
    {
      id: 'w0-policy',
      epicId: 'foundation',
      title: 'Policy',
      owner: 'architect',
      dependsOn: ['w0-contracts'],
      writePaths: ['architecture.policy.json'],
    },
    {
      id: 't1',
      epicId: 'domain',
      title: 'A',
      owner: 'developer',
      dependsOn: ['w0-policy'],
      writePaths: ['crates/a/Cargo.toml', 'crates/a/src/**'],
    },
    {
      id: 't2',
      epicId: 'domain',
      title: 'B',
      owner: 'developer',
      dependsOn: ['w0-policy'],
      writePaths: ['crates/b/Cargo.toml', 'crates/b/src/**'],
    },
  ]);
  assert.deepEqual(rustContractCrateFindings(sameEpicWave0, md), []);
});

test('X3: existing Cargo.toml [package].name maps crate directory (crates/protocol -> game-contracts) against policy.contractCrates', async t => {
  const { compileBlueprint } = await import('../runtime/project-blueprint.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-rust-x3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (rel, content) => {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf8');
  };
  const criterion = id => ({ id, text: 'cargo test passes', evidenceKinds: ['checks'] });
  const mkTask = (id, epicId, dependsOn, writePaths) => ({
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

  await put('Cargo.toml', '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n');
  await put('crates/protocol/Cargo.toml', '[package]\nname = "game-contracts"\nversion = "0.1.0"\nedition = "2021"\n');
  await put('crates/protocol/src/lib.rs', 'pub struct Id(pub u64);\n');
  await put('architecture.policy.json', {
    schemaVersion: 2,
    version: 1,
    language: 'rust',
    productRoots: ['crates'],
    layers: [
      { id: 'contracts', crates: ['game-contracts'] },
      { id: 'domain', crates: ['world', 'combat'] },
    ],
    cycles: 'forbid',
    allowedExternalCrates: [],
    allowedDevExternalCrates: [],
    contractCrates: ['game-contracts'],
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json'],
  });
  await put(
    '.kodo/blueprint/PROJECT.md',
    [
      '# Game',
      '## Цель',
      'Игра.',
      '## Модули',
      'protocol (game-contracts), world, combat.',
      '## Стек',
      'Rust 2024, Cargo workspace.',
      'contractCrate: crates/protocol',
      '## Критерии готовности',
      '- cargo test',
    ].join('\n') + '\n',
  );
  const spec = {
    schemaVersion: 1,
    id: 'rust-x3',
    root,
    title: 'Rust X3',
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
      { id: 'foundation', milestoneId: 'foundation', title: 'W0', acceptance: [criterion('fe-done')] },
      { id: 'domain', milestoneId: 'mvp', title: 'Domain', acceptance: [criterion('me-done')] },
    ],
    tasks: [
      mkTask('w0', 'foundation', [], ['Cargo.toml', 'crates/protocol/Cargo.toml', 'crates/protocol/src/**']),
      mkTask('world', 'domain', ['w0'], ['crates/world/Cargo.toml', 'crates/world/src/**']),
      mkTask('combat', 'domain', ['w0'], ['crates/combat/Cargo.toml', 'crates/combat/src/**']),
    ],
  };
  await put('.kodo/blueprint/spec.json', spec);

  // 1) Existing crates/protocol/Cargo.toml has [package].name = "game-contracts" matching policy.contractCrates -> PASS.
  const compiledOk = await compileBlueprint(root);
  assert.equal(compiledOk.ok, true, `expected compileBlueprint OK, got ${JSON.stringify(compiledOk.findings)}`);
  assert.deepEqual(compiledOk.findings, []);

  // 2) Broad mask on ordinary task still catches crates/protocol via resolved contract crate.
  const broadSpec = structuredClone(spec);
  broadSpec.tasks[1].writePaths = ['crates/**'];
  await put('.kodo/blueprint/spec.json', broadSpec);
  const compiledBroad = await compileBlueprint(root);
  assert.equal(compiledBroad.ok, false);
  assert.ok(
    compiledBroad.findings.some(f => f.code === 'contract_scope_too_broad' && f.taskIds?.includes('world')),
    `expected contract_scope_too_broad for crates/protocol, got ${JSON.stringify(compiledBroad.findings)}`,
  );

  // 3) Negative control: [package].name = "wrong-name" NOT in policy.contractCrates -> contract_crate_required.
  await put('.kodo/blueprint/spec.json', spec);
  await put('crates/protocol/Cargo.toml', '[package]\nname = "wrong-name"\nversion = "0.1.0"\nedition = "2021"\n');
  const compiledMismatch = await compileBlueprint(root);
  assert.equal(compiledMismatch.ok, false);
  assert.ok(
    compiledMismatch.findings.some(f => f.code === 'contract_crate_required'),
    `mismatched [package].name must still fail contract_crate_required, got ${JSON.stringify(compiledMismatch.findings)}`,
  );
});

test('X6: Wave 0 Rust docs/skill/bootstrap cover crate stubs, Cargo.lock, .gitignore target/, external allowlists & integrator task; invalid-package-edition has explicit hint', async t => {
  const skill = await readFile(
    path.join(import.meta.dirname, '..', 'skills', 'kodo-project-director', 'SKILL.md'),
    'utf8',
  );
  const blueprintDoc = await readFile(path.join(import.meta.dirname, '..', 'docs', 'BLUEPRINT.md'), 'utf8');
  const bootstrapSrc = await readFile(path.join(import.meta.dirname, '..', 'runtime', 'project-bootstrap.mjs'), 'utf8');
  for (const [label, text] of [
    ['SKILL.md', skill],
    ['docs/BLUEPRINT.md', blueprintDoc],
    ['runtime/project-bootstrap.mjs', bootstrapSrc],
  ]) {
    assert.match(text, /заготовк/i, `${label}: must instruct Wave 0 to create stubs for all module crates`);
    assert.match(text, /src\/lib\.rs/, `${label}: must mention src/lib.rs stubs in Wave 0`);
    assert.match(text, /Cargo\.lock/, `${label}: must instruct Wave 0 to commit Cargo.lock`);
    assert.match(text, /\.gitignore[^\n]*target\//, `${label}: must instruct Wave 0 to commit .gitignore with target/`);
    assert.match(
      text,
      /allowedExternalCrates[^\n]*allowedDevExternalCrates/,
      `${label}: must instruct Wave 0 to pre-declare allowedExternalCrates/allowedDevExternalCrates`,
    );
    assert.match(text, /\[workspace\.dependencies\]/, `${label}: must mention [workspace.dependencies] in Wave 0`);
    assert.match(
      text,
      /интегратор/i,
      `${label}: must describe dedicated integrator task for new external dependencies`,
    );
    assert.match(
      text,
      /крейта-потребителя|потребителя[^\n]*Cargo\.toml/i,
      `${label}: must note that integrator writePaths includes the consumer crate Cargo.toml`,
    );
  }

  // invalid-package-edition must emit a dedicated hint from UNSUPPORTED_ARCHITECTURE_HINTS.
  const efx = await engineFixture(t, {
    config: { architecture: { enabled: true }, repairRounds: 1, researchBudget: 0, concurrency: 1 },
    testScript: 'process.exit(0);\n',
  });
  const engine = new Engine({ store: efx.openStore(), ...fakeServices() });
  const run = await engine.create('X6 invalid-package-edition hint', {
    project: efx.project,
    mode: 'quick',
    model: 'gpt-6.1-sol',
  });
  await engine.prepare(run);
  run.models = await engine.provider.discoverProviders();
  run.plan = {
    summary: 'Bad edition',
    tasks: [planNode('x6', 'developer', ['Cargo.toml', 'crates/game-contracts/**', 'architecture.policy.json'])],
  };
  const put = async (rel, content) => {
    const full = path.join(run.cwd, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  };
  await put('Cargo.toml', '[workspace]\nresolver = "2"\nmembers = ["crates/*"]\n');
  await put(
    'crates/game-contracts/Cargo.toml',
    '[package]\nname = "game-contracts"\nversion = "0.1.0"\nedition = "bad"\n',
  );
  await put('crates/game-contracts/src/lib.rs', 'pub struct Id(pub u64);\n');
  await put('architecture.policy.json', {
    schemaVersion: 2,
    version: 1,
    language: 'rust',
    productRoots: ['crates'],
    layers: [{ id: 'contracts', crates: ['game-contracts'] }],
    cycles: 'forbid',
    allowedExternalCrates: [],
    allowedDevExternalCrates: [],
    contractCrates: ['game-contracts'],
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json'],
  });
  fixtureGit(run.cwd, 'add', '-A');
  fixtureGit(run.cwd, 'commit', '-m', 'invalid edition manifest');

  await engine.checks(run);
  await assert.rejects(engine.verificationGates(run), err => {
    assert.equal(err.code, 'verification_failed');
    const failures = JSON.parse(err.message.slice(err.message.indexOf('[')));
    const finding = failures
      .flatMap(entry => entry.findings || [])
      .find(row => row.ruleId === 'unsupported.invalid-package-edition');
    assert.ok(finding, `expected unsupported.invalid-package-edition in ${err.message}`);
    assert.match(finding.hint || '', /edition/i, `expected edition-specific hint, got ${JSON.stringify(finding)}`);
    return true;
  });
});

test('Y1: Rust v2 epic gate blocks fail-closed when any gate task lacks valid headSha or mismatches merge manifest (run + revalidation)', async t => {
  const fx = await rustFixture(t);
  await fx.put('crates/game-contracts/src/types.rs', 'pub struct V1;\n');
  const migrateCommit = fx.commit('migrate-contracts commit');
  await fx.put('crates/world/src/lib.rs', 'pub fn tick() -> u64 { 10 }\n');
  await fx.put('crates/game-contracts/src/lib.rs', 'pub struct UnauthorizedEdit;\n');
  const sneakyCommit = fx.commit('world-task sneaky contract edit');

  const gateMod = await import('../runtime/architecture-gate.mjs');
  const missingShaGateRun = {
    planSource: 'gate',
    directorBinding: { kind: 'gate' },
    plan: {
      tasks: [
        { id: 'migrate-contracts', writePaths: ['crates/game-contracts/**'] },
        { id: 'world-task', writePaths: ['crates/world/**'] },
      ],
    },
    nodes: {
      'migrate-contracts': { id: 'migrate-contracts', headSha: migrateCommit },
      // world-task intentionally missing headSha!
      'world-task': { id: 'world-task' },
    },
  };
  const missingScopes = gateMod.architectureTaskScopesForRun(missingShaGateRun);
  const blockedReceipt = await runArchitectureChecks({
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha: sneakyCommit,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths: gateMod.architectureTaskPathsForRun(missingShaGateRun),
    taskScopes: missingScopes,
  });
  assert.equal(
    blockedReceipt.status,
    'blocked',
    `missing headSha on epic gate must block, got ${JSON.stringify(blockedReceipt)}`,
  );
  assert.equal(blockedReceipt.passed, false);
  assert.equal(blockedReceipt.reason, 'configuration');

  // Non-existent commit SHA on epic gate task must also block, never pass.
  const bogusShaGateRun = {
    ...missingShaGateRun,
    nodes: {
      'migrate-contracts': { id: 'migrate-contracts', headSha: migrateCommit },
      'world-task': { id: 'world-task', headSha: 'f'.repeat(40) },
    },
  };
  const bogusReceipt = await runArchitectureChecks({
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha: sneakyCommit,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths: gateMod.architectureTaskPathsForRun(bogusShaGateRun),
    taskScopes: gateMod.architectureTaskScopesForRun(bogusShaGateRun),
  });
  assert.equal(bogusReceipt.status, 'blocked');
  assert.equal(bogusReceipt.passed, false);
  assert.equal(bogusReceipt.reason, 'configuration');

  // Revalidation: a valid clean epic gate receipt MUST fail freshness when revalidated with missing headSha or mismatched gate manifest.
  const cleanFx = await rustFixture(t);
  await cleanFx.put('crates/game-contracts/src/lib.rs', 'pub struct CleanV3;\n');
  const cleanMigrate = cleanFx.commit('clean migrate');
  await cleanFx.put('crates/world/src/lib.rs', 'pub fn tick() -> u64 { 11 }\n');
  const cleanWorld = cleanFx.commit('clean world');
  const cleanGateRun = {
    planSource: 'gate',
    directorBinding: { kind: 'gate' },
    plan: {
      tasks: [
        { id: 'migrate-contracts', writePaths: ['crates/game-contracts/**'] },
        { id: 'world-task', writePaths: ['crates/world/**'] },
      ],
    },
    nodes: {
      'migrate-contracts': { id: 'migrate-contracts', headSha: cleanMigrate },
      'world-task': { id: 'world-task', headSha: cleanWorld },
    },
  };
  const cleanOpts = {
    cwd: cleanFx.project,
    baseSha: cleanFx.baseSha,
    headSha: cleanWorld,
    config: { enabled: true },
    artifacts: cleanFx.artifacts,
    taskPaths: gateMod.architectureTaskPathsForRun(cleanGateRun),
    taskScopes: gateMod.architectureTaskScopesForRun(cleanGateRun),
  };
  const cleanReceipt = await runArchitectureChecks(cleanOpts);
  assert.equal(cleanReceipt.status, 'passed');
  assert.equal(await isCurrentArchitectureReceipt(cleanReceipt, cleanOpts), true);
  // Missing headSha in revalidation -> false.
  const incompleteRevalRun = {
    ...cleanGateRun,
    nodes: {
      'migrate-contracts': { id: 'migrate-contracts', headSha: cleanMigrate },
      'world-task': { id: 'world-task' },
    },
  };
  assert.equal(
    await isCurrentArchitectureReceipt(cleanReceipt, {
      ...cleanOpts,
      taskScopes: gateMod.architectureTaskScopesForRun(incompleteRevalRun),
    }),
    false,
  );
  // Gate manifest mismatch (mergeCommit differs from node.headSha) -> false.
  const mismatchScopes = gateMod.architectureTaskScopesForRun(cleanGateRun, {
    gate: {
      merges: [
        { taskId: 'migrate-contracts', mergeCommit: cleanMigrate },
        { taskId: 'world-task', mergeCommit: cleanMigrate },
      ],
    },
    tasks: cleanGateRun.plan.tasks,
  });
  assert.equal(await isCurrentArchitectureReceipt(cleanReceipt, { ...cleanOpts, taskScopes: mismatchScopes }), false);
});

test('Y2: ordinary Engine node uses baseSha..headSha (no-op node does not falsely inherit base commit contract edits)', async t => {
  const fx = await rustFixture(t);
  // Task 1 legitimately edits Cargo.toml and contract crate on commit 1.
  await fx.put('crates/game-contracts/src/lib.rs', 'pub struct ContractV2;\n');
  const afterT1 = fx.commit('t1 contract update');

  const gateMod = await import('../runtime/architecture-gate.mjs');
  // Ordinary (non-epic) Engine run: t2 committed nothing so node.baseSha === node.headSha === afterT1.
  const ordinaryRun = {
    planSource: 'cli',
    baseSha: fx.baseSha,
    plan: {
      tasks: [
        { id: 't1', writePaths: ['Cargo.toml', 'crates/game-contracts/**'] },
        { id: 't2', writePaths: ['crates/world/**'] },
      ],
    },
    nodes: {
      t1: { id: 't1', baseSha: fx.baseSha, headSha: afterT1 },
      t2: { id: 't2', baseSha: afterT1, headSha: afterT1 },
    },
  };
  const taskPaths = gateMod.architectureTaskPathsForRun(ordinaryRun);
  const taskScopes = gateMod.architectureTaskScopesForRun(ordinaryRun);
  const receipt = await runArchitectureChecks({
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha: afterT1,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths,
    taskScopes,
  });
  assert.equal(
    receipt.status,
    'passed',
    `no-op ordinary Engine node must have empty diff (baseSha..headSha), got ${JSON.stringify(receipt.report)}`,
  );
  assert.equal(
    await isCurrentArchitectureReceipt(receipt, {
      cwd: fx.project,
      baseSha: fx.baseSha,
      headSha: afterT1,
      config: { enabled: true },
      taskPaths,
      taskScopes,
    }),
    true,
  );

  // When t2 actually commits an unauthorized contract edit between t2.baseSha..t2.headSha -> must FAIL.
  await fx.put('crates/game-contracts/src/lib.rs', 'pub struct SneakyFromT2;\n');
  const afterT2Bad = fx.commit('t2 sneaky contract edit');
  const ordinaryRunBad = {
    ...ordinaryRun,
    nodes: {
      t1: { id: 't1', baseSha: fx.baseSha, headSha: afterT1 },
      t2: { id: 't2', baseSha: afterT1, headSha: afterT2Bad },
    },
  };
  const badReceipt = await runArchitectureChecks({
    cwd: fx.project,
    baseSha: fx.baseSha,
    headSha: afterT2Bad,
    config: { enabled: true },
    artifacts: fx.artifacts,
    taskPaths: gateMod.architectureTaskPathsForRun(ordinaryRunBad),
    taskScopes: gateMod.architectureTaskScopesForRun(ordinaryRunBad),
  });
  assert.equal(badReceipt.status, 'failed');
  assert.ok(
    badReceipt.report.findings.some(
      f => f.ruleId === 'contract_change_not_allowed' && f.file === 'crates/game-contracts/src/lib.rs',
    ),
  );
});

test('Y3: scopeMatchesPath and isExplicitContractScope match ownsPath exactly for brace patterns (expansion stays linter-only)', async t => {
  const { scopeMatchesPath, isExplicitContractScope, isBroadContractScope } =
    await import('../runtime/cargo-workspace.mjs');
  const { ownsPath } = await import('../runtime/contracts.mjs');

  const pairs = [
    ['crates/game-contracts/{src,tests}', 'crates/game-contracts/src/v2.rs', false],
    ['crates/game-contracts/{src,tests}/**', 'crates/game-contracts/src/v2.rs', true],
    ['crates/game-contracts/src/v{1..3}.rs', 'crates/game-contracts/src/v2.rs', true],
    ['crates/game-contracts/src/v{1..3}.rs', 'crates/game-contracts/src/v4.rs', false],
    ['crates/game-contracts/**', 'crates/game-contracts/.gitignore', true],
    ['crates/game-contracts', 'crates/game-contracts/src/lib.rs', true],
  ];
  for (const [scope, file, expected] of pairs) {
    assert.equal(ownsPath([scope], file), expected, `sanity ownsPath(${scope}, ${file})`);
    assert.equal(scopeMatchesPath(scope, file), expected, `scopeMatchesPath(${scope}, ${file}) must match ownsPath`);
    assert.equal(
      isExplicitContractScope(scope, 'crates/game-contracts', file),
      expected,
      `isExplicitContractScope(${scope}, game-contracts, ${file}) must match ownsPath`,
    );
  }
  // Brace expansion remains active in isBroadContractScope for linter detection.
  assert.equal(isBroadContractScope('{crates/game-contracts,crates/world}/src/**', 'crates/game-contracts'), true);

  // End-to-end checkArchitecture verification of both Y3 cases.
  const fx = await rustFixture(t);
  await fx.put('crates/game-contracts/src/v2.rs', 'pub struct V2;\n');
  fx.commit('add v2.rs');

  const deniedBraceDir = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    taskPaths: ['crates/game-contracts/{src,tests}'],
  });
  assert.equal(deniedBraceDir.status, 'failed');
  assert.ok(
    deniedBraceDir.findings.some(
      f => f.ruleId === 'contract_change_not_allowed' && f.file === 'crates/game-contracts/src/v2.rs',
    ),
  );

  const allowedBraceRange = await checkArchitecture({
    project: fx.project,
    baseSha: fx.baseSha,
    taskPaths: ['crates/game-contracts/src/v{1..3}.rs'],
  });
  assert.equal(
    allowedBraceRange.status,
    'passed',
    `crates/game-contracts/src/v{1..3}.rs must allow src/v2.rs like ownsPath, got ${JSON.stringify(allowedBraceRange)}`,
  );
});

test('Y4: JS v1 architecture receipt remains fresh after run.nodes is populated (taskScopes applies only to Rust v2)', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodo-arch-js-y4-'));
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'kodo-arch-js-y4-art-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  });
  const gitIn = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = async (rel, content) => {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  };
  gitIn('init');
  gitIn('config', 'user.email', 'test@example.com');
  gitIn('config', 'user.name', 'Test');
  await put('src/core/index.mjs', 'export const answer = () => 42;\n');
  await put('src/app/index.mjs', 'export const run = () => 1;\n');
  await put('architecture.contracts.json', { schemaVersion: 1, contracts: [], migrations: [] });
  await put('architecture.policy.json', {
    schemaVersion: 1,
    version: 1,
    productRoots: ['src'],
    modules: [
      { id: 'core', roots: ['src/core'], layer: 'core', public: [], allow: [] },
      { id: 'app', roots: ['src/app'], layer: 'app', public: [], allow: ['core'] },
    ],
    layers: { app: ['core'], core: [] },
    forbiddenImports: [],
    cycles: 'forbid',
    contracts: 'architecture.contracts.json',
    baseline: [],
    exceptions: [],
    protectedPaths: ['architecture.policy.json'],
  });
  gitIn('add', '-A');
  gitIn('commit', '-m', 'base js v1');
  const baseSha = gitIn('rev-parse', 'HEAD');
  await put('src/app/index.mjs', 'export const run = () => 2;\n');
  gitIn('add', '-A');
  gitIn('commit', '-m', 'update js v1');
  const headSha = gitIn('rev-parse', 'HEAD');

  // Receipt issued without taskScopes (like legacy/pre-node JS v1 run).
  const receipt = await runArchitectureChecks({
    cwd: dir,
    baseSha,
    headSha,
    config: { enabled: true },
    artifacts,
  });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.taskScopes, undefined);

  // After run.nodes is populated (and even for a gate run with incomplete nodes), JS v1 receipt stays fresh!
  const gateMod = await import('../runtime/architecture-gate.mjs');
  const runWithNodes = {
    baseSha,
    headSha,
    plan: { tasks: [{ id: 't1', writePaths: ['src/core/**'] }] },
    nodes: { t1: { id: 't1', baseSha, headSha } },
  };
  assert.equal(
    await isCurrentArchitectureReceipt(receipt, {
      cwd: dir,
      baseSha,
      headSha,
      config: { enabled: true },
      taskPaths: gateMod.architectureTaskPathsForRun(runWithNodes),
      taskScopes: gateMod.architectureTaskScopesForRun(runWithNodes),
    }),
    true,
  );
});

test('Y5: package.workspace mismatch on member or conflict with exclude blocks as unsupported', async t => {
  const { resolveCargoWorkspace } = await import('../runtime/cargo-workspace.mjs');

  // 1) Member points package.workspace to sibling workspace -> wrong-workspace-root.
  const wrongWs = resolveCargoWorkspace({
    manifests: {
      'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["crates/a"]\n',
      'crates/a/Cargo.toml':
        '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\nworkspace = "../../other-ws"\n',
      'other-ws/Cargo.toml': '[workspace]\nresolver = "2"\nmembers = []\n',
    },
    files: ['Cargo.toml', 'crates/a/Cargo.toml', 'crates/a/src/lib.rs', 'other-ws/Cargo.toml'],
  });
  assert.ok(
    wrongWs.unsupported.some(u => u.reason === 'wrong-workspace-root' && u.file === 'crates/a/Cargo.toml'),
    `expected wrong-workspace-root, got ${JSON.stringify(wrongWs.unsupported)}`,
  );

  // 2) Excluded package explicitly declaring package.workspace pointing to excluding workspace -> unlisted-workspace-member (not standalone).
  const excludedExplicit = resolveCargoWorkspace({
    startDir: 'crates/excluded',
    manifests: {
      'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["crates/a"]\nexclude = ["crates/excluded"]\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
      'crates/excluded/Cargo.toml':
        '[package]\nname = "excluded"\nversion = "0.1.0"\nedition = "2021"\nworkspace = "../.."\n',
    },
    files: [
      'Cargo.toml',
      'crates/a/Cargo.toml',
      'crates/a/src/lib.rs',
      'crates/excluded/Cargo.toml',
      'crates/excluded/src/lib.rs',
    ],
  });
  assert.ok(
    excludedExplicit.unsupported.some(
      u => u.reason === 'unlisted-workspace-member' && u.file === 'crates/excluded/Cargo.toml',
    ),
    `expected unlisted-workspace-member for excluded package with explicit package.workspace, got ${JSON.stringify(excludedExplicit)}`,
  );

  // 3) Manifest with both [workspace] and package.workspace -> invalid-workspace-config.
  const bothWs = resolveCargoWorkspace({
    manifests: {
      'Cargo.toml':
        '[workspace]\nresolver = "2"\nmembers = []\n[package]\nname = "root"\nversion = "0.1.0"\nedition = "2021"\nworkspace = "."\n',
    },
    files: ['Cargo.toml', 'src/lib.rs'],
  });
  assert.ok(
    bothWs.unsupported.some(u => u.reason === 'invalid-workspace-config' && u.file === 'Cargo.toml'),
    `expected invalid-workspace-config when both [workspace] and package.workspace set, got ${JSON.stringify(bothWs.unsupported)}`,
  );

  // 4) Member pointing package.workspace to SAME workspace root -> clean PASS.
  const sameWs = resolveCargoWorkspace({
    manifests: {
      'Cargo.toml': '[workspace]\nresolver = "2"\nmembers = ["crates/a"]\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\nworkspace = "../.."\n',
    },
    files: ['Cargo.toml', 'crates/a/Cargo.toml', 'crates/a/src/lib.rs'],
  });
  assert.deepEqual(sameWs.unsupported, []);
  assert.equal(sameWs.members.length, 1);

  // 5) End-to-end checkArchitecture blocks when a member has wrong package.workspace.
  const fx = await rustFixture(t);
  await fx.put('other-ws/Cargo.toml', '[workspace]\nresolver = "2"\nmembers = []\n');
  await fx.put(
    'crates/world/Cargo.toml',
    '[package]\nname = "world"\nversion = "0.1.0"\nedition = "2021"\nworkspace = "../../other-ws"\n[dependencies]\ngame-contracts = { path = "../game-contracts" }\n',
  );
  fx.commit('wrong package.workspace');
  const blocked = await checkArchitecture({ project: fx.project, baseSha: fx.baseSha });
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.unsupported.some(u => u.reason === 'wrong-workspace-root'));
});

test('wave gate scopes contract and protected paths to its own repair', async t => {
  const fx = await rustFixture(t);
  const branch = fx.git(['branch', '--show-current']);
  fx.git(['checkout', '-qb', 'world-task']);
  await fx.put('crates/world/src/lib.rs', 'pub struct UpdatedWorld;\n');
  fx.commit('world task');
  fx.git(['checkout', '-q', branch]);
  fx.git(['merge', '--no-ff', 'world-task', '-m', 'integrate world']);
  const worldMerge = fx.git(['rev-parse', 'HEAD']);
  await fx.put('Cargo.toml', defaultWorkspaceFiles()['Cargo.toml'] + '# integrator\n');
  const integrator = fx.commit('foreign integrator');
  fx.git(['checkout', '-qb', 'repair-a']);
  await fx.put('crates/game-contracts/tests/public_api.rs', '// repair A\n');
  const repairA = fx.commit('foundation repair');
  fx.git(['checkout', '-q', branch]);
  fx.git(['merge', '--no-ff', 'repair-a', '-m', 'Kodo: integrate gate repairs']);
  const scopeBaseSha = fx.git(['rev-parse', 'HEAD']);
  const opts = {
    cwd: fx.project,
    artifacts: fx.artifacts,
    config: { enabled: true },
    baseSha: fx.baseSha,
    headSha: scopeBaseSha,
    scopeBaseSha,
    taskPaths: ['crates/world'],
    taskScopes: [{ id: 'world', mode: 'merge', commit: worldMerge, writePaths: ['crates/world'] }],
  };
  const receipt = await runArchitectureChecks(opts);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.requiresReview, false);
  assert.equal(await isCurrentArchitectureReceipt(receipt, opts), true);
  const { scopeBaseSha: bound, ...legacy } = receipt;
  assert.equal(bound, scopeBaseSha);
  assert.equal(await isCurrentArchitectureReceipt(legacy, opts), false);
  assert.equal(await isCurrentArchitectureReceipt(receipt, { ...opts, scopeBaseSha: integrator }), false);
  await fx.put('crates/game-contracts/tests/foreign.rs', '// repair B\n');
  const headSha = fx.commit('unauthorized repair');
  const report = await checkArchitecture({ project: fx.project, ...opts, headSha });
  assert.ok(report.findings.some(row => row.ruleId === 'contract_change_not_allowed'));
  for (const [base, scope] of [
    [scopeBaseSha, repairA],
    [integrator, null],
  ]) {
    await assert.rejects(checkArchitecture({ project: fx.project, baseSha: base, scopeBaseSha: scope, headSha }), {
      code: 'configuration',
    });
  }
  fx.git(['checkout', '-q', repairA]);
  await assert.rejects(
    checkArchitecture({ project: fx.project, baseSha: fx.baseSha, scopeBaseSha, headSha: repairA }),
    { code: 'configuration' },
  );
});
