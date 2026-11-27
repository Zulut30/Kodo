// Project factory blueprint: a filesystem-first plan under <root>/.kodo/blueprint
// that Kodo checks and compiles into ProjectSpec v1. Reads are bounded and
// link-free; lint is pure and deterministic. No provider sessions, network or
// writes. Kodo never splits tasks itself: the main chat edits the blueprint.
import * as projectContracts from './project-contracts.mjs';
import {
  hasCommittedCargoManifest,
  projectRoot,
  readBlueprintAtRoot,
  readBlueprintCommit,
  readOptionalArchitecturePolicy,
  readOptionalRustToolchain,
  resolveSource,
} from './project-blueprint-io.mjs';
import { normalizeFactory, sectionFindings } from './project-blueprint-spec.mjs';
import { MAX_MILESTONE_TASKS, MAX_PROJECT_TASKS, finding } from './project-blueprint-shared.mjs';
import {
  containerFindings,
  epicCycleFindings,
  interfaceFindings,
  moduleOwnerFindings,
  overlapFindings,
  ownerFindings,
  parallelOverlaps,
  storedProject,
  taskAncestors,
  taskInputFindings,
  taskScopeSizeFindings,
  waveZeroFindings,
} from './project-blueprint-lint.mjs';
import { readCargoPackagePlan, rustContractCrateFindings, rustToolchainFindings } from './project-blueprint-rust.mjs';

export {
  BLUEPRINT_DIR,
  MAX_MILESTONE_TASKS,
  MAX_PROJECT_TASKS,
  MAX_TASK_INPUT_BYTES,
  MAX_TASK_WRITE_PATHS,
  MAX_TASK_MODULES,
  FOUNDATION_ID,
  FACTORY_ROLES,
  DEFAULT_EXECUTION,
  REQUIRED_SECTIONS,
  BLUEPRINT_LIMITS,
  finding,
} from './project-blueprint-shared.mjs';
export { readBoundedFile, readBlueprint, bindInterfaceEvidence } from './project-blueprint-io.mjs';
export { markdownHeadings } from './project-blueprint-spec.mjs';
export {
  taskAncestors,
  parallelOverlaps,
  isSharedIntegrationPath,
  overlapFindings,
  moduleOwnerFindings,
  taskScopeSizeFindings,
  ownerFindings,
  taskInputFindings,
  epicCycleFindings,
  containerFindings,
} from './project-blueprint-lint.mjs';
export { rustContractCrateFindings, rustToolchainFindings } from './project-blueprint-rust.mjs';

function analyzeFactorySpec(spec, options = {}, cargoPlan = undefined) {
  const {
    contracts = projectContracts,
    knownValues = [],
    interfaces = [],
    projectMarkdown = '',
    architecturePolicy = null,
    packageNames = null,
    hasRustToolchain = false,
    hasCommittedCargoManifest = false,
  } = options;
  const base = normalizeFactory(spec, { contracts, knownValues });
  const findings = [...base.findings, ...sectionFindings(projectMarkdown)];
  if (!base.spec) return { spec: null, findings };
  if (base.spec.tasks.length > MAX_PROJECT_TASKS)
    findings.push(finding('project_task_count', 'Проект содержит больше 400 задач'));
  const parents = new Map(base.spec.epics.map(epic => [epic.id, epic.milestoneId]));
  const counts = new Map();
  for (const task of base.spec.tasks) {
    const milestone = parents.get(task.epicId);
    counts.set(milestone, (counts.get(milestone) ?? 0) + 1);
  }
  for (const [id, count] of counts)
    if (count > MAX_MILESTONE_TASKS)
      findings.push(finding('milestone_task_count', 'В майлстоуне ' + id + ' больше 80 задач'));
  const ancestors = taskAncestors(base.spec.tasks);
  const pairs = parallelOverlaps(base.spec.tasks, { ancestors });
  const inputFindings = taskInputFindings({
    project: storedProject(base.spec),
    tasks: base.spec.tasks,
    contracts,
    knownValues,
  });
  const alreadyOversized = new Set(
    inputFindings.filter(item => item.code === 'split_required').flatMap(item => item.taskIds ?? []),
  );
  findings.push(
    ...ownerFindings(base.spec.tasks),
    ...waveZeroFindings(base.spec, ancestors),
    ...rustToolchainFindings(base.spec, projectMarkdown, architecturePolicy, {
      hasRustToolchain,
      hasCommittedCargoManifest,
    }),
    ...rustContractCrateFindings(base.spec, projectMarkdown, architecturePolicy, ancestors, packageNames, cargoPlan),
    ...containerFindings(base.spec),
    ...epicCycleFindings(base.spec.tasks),
    ...overlapFindings(pairs, base.spec.tasks),
    ...moduleOwnerFindings(base.spec, { parallelPairs: pairs }),
    ...inputFindings,
    ...taskScopeSizeFindings(base.spec.tasks, alreadyOversized),
    ...interfaceFindings(base.spec, interfaces),
  );
  return { spec: base.spec, findings };
}
/** Deterministic factory rules over a ProjectSpec v1 (+ execution).
 * options: { contracts, knownValues = [], interfaces = [], projectMarkdown = '' };
 * omitted interfaces/PROJECT.md are treated as empty, never as passing. */
export function lintFactorySpec(spec, options = {}) {
  const { findings } = analyzeFactorySpec(spec, options);
  return { ok: findings.length === 0, findings };
}
/** Read, resolve and lint the blueprint. Returns the compiled ProjectSpec
 * (with execution) even when findings exist; ok is the only acceptance signal.
 * headSha identifies the commit used for Git evidence, or null if none was read.
 * Registration also reads the policy and selected package names from that commit.
 * Standalone compilation reads those optional files from the working directory.
 * `specFile` optionally replaces .kodo/blueprint/spec.json. Nothing is written to disk.
 * @param {string} root
 * @param {{ contracts?: typeof projectContracts, knownValues?: string[], specFile?: string, forRegistration?: boolean, architecturePolicy?: Record<string, any> | null, packageNames?: Map<string, string> | Record<string, string> | null, hasRustToolchain?: boolean, hasCommittedCargoManifest?: boolean }} [options] */
export async function compileBlueprint(
  root,
  {
    contracts = projectContracts,
    knownValues = [],
    specFile,
    forRegistration = false,
    architecturePolicy,
    packageNames,
    hasRustToolchain,
    hasCommittedCargoManifest: committedCargo,
  } = {},
) {
  let blueprint;
  let headSha = null;
  try {
    const real = await projectRoot(root);
    if (forRegistration) headSha = await readBlueprintCommit(real);
    blueprint = await readBlueprintAtRoot(real, specFile);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('blueprint_'))
      return { ok: false, headSha, spec: null, interfaces: [], findings: [finding(error.code, error.message)] };
    throw error;
  }
  const source = await resolveSource(blueprint);
  let cargoPlan;
  let policy = architecturePolicy,
    resolvedPackageNames = packageNames;
  try {
    if (policy === undefined) policy = await readOptionalArchitecturePolicy(blueprint.root, headSha);
    if (resolvedPackageNames === undefined) {
      const metadata = await readCargoPackagePlan(
        blueprint.root,
        source.value,
        blueprint.project.text,
        headSha,
        policy,
      );
      resolvedPackageNames = metadata.names;
      cargoPlan = metadata.plan;
    }
  } catch (error) {
    if (error?.code !== 'blueprint_cargo_evidence_unavailable') throw error;
    source.findings.push(finding(error.code, error.message));
  }
  let resolvedToolchain = Boolean(hasRustToolchain);
  let resolvedCommittedCargo = Boolean(committedCargo);
  if (!resolvedToolchain && (hasRustToolchain === undefined || committedCargo === undefined)) {
    try {
      if (!forRegistration) headSha = await readBlueprintCommit(blueprint.root);
      if (headSha) {
        if (hasRustToolchain === undefined)
          resolvedToolchain = await readOptionalRustToolchain(blueprint.root, headSha);
        if (committedCargo === undefined && !resolvedToolchain)
          resolvedCommittedCargo = await hasCommittedCargoManifest(
            blueprint.root,
            source.value,
            headSha,
            forRegistration ? cargoPlan?.tree : undefined,
          );
      }
    } catch (error) {
      if (error?.code !== 'blueprint_cargo_evidence_unavailable') throw error;
      if (!source.findings.some(item => item.code === error.code))
        source.findings.push(finding(error.code, error.message));
    }
  }
  const analysis = analyzeFactorySpec(
    source.value,
    {
      contracts,
      knownValues,
      interfaces: blueprint.interfaces,
      projectMarkdown: blueprint.project.text,
      architecturePolicy: policy,
      packageNames: resolvedPackageNames,
      hasRustToolchain: resolvedToolchain,
      hasCommittedCargoManifest: resolvedCommittedCargo,
    },
    cargoPlan,
  );
  const findings = [...source.findings, ...analysis.findings];
  return { ok: findings.length === 0, headSha, spec: analysis.spec, interfaces: blueprint.interfaces, findings };
}
