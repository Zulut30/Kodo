// Plan lint of the project factory blueprint (`project-blueprint.mjs`): task
// ancestry and parallel overlaps, write scope ownership, task inputs, wave
// zero, epic cycles, containers and interface findings. Pure and deterministic.

import * as projectContracts from './project-contracts.mjs';
import { scopesOverlap } from './contracts.mjs';
import {
  FACTORY_ROLES,
  FOUNDATION_ID,
  MAX_TASK_INPUT_BYTES,
  MAX_TASK_MODULES,
  MAX_TASK_WRITE_PATHS,
  compare,
  finding,
  slashed,
  windowsLike,
} from './project-blueprint-shared.mjs';
import { errorCode } from './project-blueprint-spec.mjs';

const PAIR_CAP = 100;
// Stored-record stand-ins used only to measure the real Director task input.
// The maximal revision keeps the estimate conservative for later revisions.
const LINT_PROJECT_ID = '00000000-0000-4000-8000-000000000000';
const LINT_AT = '2000-01-01T00:00:00.000Z';
const LINT_REVISION = Number.MAX_SAFE_INTEGER;
/** Transitive dependencies of every task; unknown ids end the walk. */
export function taskAncestors(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task])),
    memo = new Map();
  const visit = id => {
    if (memo.has(id)) return memo.get(id);
    const set = new Set();
    memo.set(id, set);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      set.add(dependency);
      for (const ancestor of visit(dependency)) set.add(ancestor);
    }
    return set;
  };
  for (const task of tasks) visit(task.id);
  return memo;
}
/** Pairs of tasks without a dependency path between them whose writePaths overlap.
 * `others` are tasks that may run concurrently with every task in `tasks`. */
export function parallelOverlaps(tasks, { ancestors = taskAncestors(tasks), others = [] } = {}) {
  // Each node indexes tasks ending at this literal directory and tasks anywhere below it.
  // A wildcard inside a component leaves the whole component to the canonical matcher.
  const node = () => ({ children: new Map(), ends: new Set(), below: new Set() });
  const root = node();
  const all = [...tasks, ...others];
  const indexed = all.map((task, index) =>
    task.writePaths.map(scope => {
      const parts = scope.replace(/^\.\//, '').split('/');
      const segments = [];
      if (!parts.includes('..')) {
        for (const part of parts) {
          if (!part || part === '.' || /[^a-zA-Z0-9_.-]/.test(part)) break;
          segments.push(part.toLowerCase());
        }
      }
      return { index, scope, segments };
    }),
  );
  for (const paths of indexed) {
    for (const entry of paths) {
      let at = root;
      at.below.add(entry);
      for (const part of entry.segments) {
        if (!at.children.has(part)) at.children.set(part, node());
        at = at.children.get(part);
        at.below.add(entry);
      }
      at.ends.add(entry);
    }
  }
  const pairs = [];
  for (const [i, left] of tasks.entries()) {
    const matches = new Set();
    for (const entry of indexed[i]) {
      const compareEntries = candidates => {
        for (const { index, scope } of candidates) {
          if (index <= i || matches.has(index)) continue;
          const right = all[index];
          if (ancestors.get(left.id)?.has(right.id) || (index < tasks.length && ancestors.get(right.id)?.has(left.id)))
            continue;
          if (scopesOverlap([entry.scope], [scope])) matches.add(index);
        }
      };
      let at = root;
      for (const part of entry.segments) {
        compareEntries(at.ends);
        at = at.children.get(part);
      }
      compareEntries(at.below);
    }
    for (const index of [...matches].sort((a, b) => a - b)) pairs.push([left.id, all[index].id]);
  }
  return pairs;
}
const SHARED_INTEGRATION_FILES = new Set([
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'package.json',
  'package-lock.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'kodo.config.json',
]);
const SHARED_ENTRYPOINT = /^(?:src\/|cli\/)?(?:main|index|lib|app)\.(?:rs|[cm]?[jt]sx?)$/;
const WORKSPACE_SHARED_FILE =
  /^(?:crates|packages|modules|libs|services|apps)\/[^/*?[{]+\/(?:Cargo\.toml|package\.json|src\/(?:lib|main|index)\.(?:rs|[cm]?[jt]sx?))$/;
const UNBOUNDED_SCOPE =
  /^(?:\.|\.\.?\/\*+|\*+|\*\*\/\*+|(?:src|crates|packages|modules|libs)(?:\/\*+|\/\*\*|\/\*\*\/\*+)?)$/;
const MODULE_SCOPE = /^((?:src|crates|packages|modules|libs|services|apps|runtime)\/[^/*?[{]+)/;
const cleanScope = scope =>
  String(scope ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
/** Whether a writePath targets a shared root manifest or entrypoint that parallel tasks must not co-edit. */
export function isSharedIntegrationPath(scope) {
  const normalized = cleanScope(scope);
  return SHARED_INTEGRATION_FILES.has(normalized) || SHARED_ENTRYPOINT.test(normalized);
}
/** Whether a writePath is a shared manifest/entrypoint that an `integrator` task may touch without split_required. */
function isIntegratorExemptPath(scope) {
  return isSharedIntegrationPath(scope) || WORKSPACE_SHARED_FILE.test(cleanScope(scope));
}
/** Whether a writePath is an unbounded root/container wildcard without a concrete module owner. */
function isUnboundedWritePath(scope) {
  return UNBOUNDED_SCOPE.test(cleanScope(scope));
}
function moduleOfWritePath(scope) {
  const match = MODULE_SCOPE.exec(cleanScope(scope));
  return match ? match[1] : null;
}
function pairSharesIntegrationFile(left, right) {
  if (!left || !right) return false;
  for (const a of left.writePaths ?? [])
    for (const b of right.writePaths ?? [])
      if ((isSharedIntegrationPath(a) || isSharedIntegrationPath(b)) && scopesOverlap([a], [b])) return true;
  return false;
}
export function overlapFindings(pairs, tasks = []) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visible = pairs.slice(0, PAIR_CAP);
  return visible.map((pair, index) => {
    const rest = index === visible.length - 1 && pairs.length > visible.length;
    const suffix = rest ? `; ещё пар: ${pairs.length - visible.length}` : '';
    if (pairSharesIntegrationFile(byId.get(pair[0]), byId.get(pair[1]))) {
      return finding(
        'integrator_required',
        `Задачи ${pair[0]} и ${pair[1]} в одной волне пересекаются по общим файлам (Cargo.toml, package.json или точка входа); вынесите правку общих файлов в отдельную задачу-интегратор${suffix}`,
        pair,
      );
    }
    return finding(
      'blueprint_parallel_overlap',
      `Задачи ${pair[0]} и ${pair[1]} могут идти параллельно, но их writePaths пересекаются${suffix}`,
      pair,
    );
  });
}
function ownedModulesOf(task) {
  const paths =
    task.owner === 'integrator'
      ? (task.writePaths ?? []).filter(p => !isIntegratorExemptPath(p))
      : (task.writePaths ?? []);
  return new Set(paths.map(moduleOfWritePath).filter(Boolean));
}
function indexOwnersByModule(tasks, foundationEpics) {
  const byModule = new Map();
  for (const task of tasks) {
    if (foundationEpics.has(task.epicId) || task.status === 'cancelled') continue;
    for (const mod of ownedModulesOf(task)) {
      const list = byModule.get(mod) ?? [];
      list.push(task);
      byModule.set(mod, list);
    }
  }
  return byModule;
}
const CLOSED_OWNER_STATUSES = new Set(['accepted', 'released', 'cancelled']);
/** Reject tasks without an unambiguous module/write owner: unbounded catch-all scopes
 * or multiple non-foundation epics claiming write ownership of the same module.
 * When `existingTasks`/`existingEpics` are supplied (`append-milestone`), only non-closed
 * existing tasks count as active module owners, and a new task that transitively depends
 * on all existing owners of a module is a sequential extension, not a conflict. */
export function moduleOwnerFindings(
  spec,
  { parallelPairs = [], existingTasks = [], existingEpics = [], ancestors = null } = {},
) {
  const findings = [];
  const unbounded = spec.tasks.filter(task => (task.writePaths ?? []).some(isUnboundedWritePath)).map(task => task.id);
  if (unbounded.length) {
    findings.push(
      finding(
        'blueprint_owner_ambiguous',
        'Задача должна задавать однозначный модуль/область записи, без корневых или контейнерных шаблонов (., **, src/**, crates/**)',
        unbounded,
      ),
    );
  }
  const foundationEpics = new Set(
    [...(spec.epics ?? []), ...(existingEpics ?? [])]
      .filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID)
      .map(epic => epic.id),
  );
  const openExisting = (existingTasks ?? []).filter(task => !CLOSED_OWNER_STATUSES.has(task.status));
  const ancestorMap = ancestors ?? taskAncestors([...openExisting, ...(spec.tasks ?? [])]);
  const parallelSet = new Set(parallelPairs.map(([a, b]) => (a < b ? `${a}\0${b}` : `${b}\0${a}`)));
  const freshByModule = indexOwnersByModule(spec.tasks, foundationEpics);
  const existingByModule = indexOwnersByModule(openExisting, foundationEpics);

  for (const [mod, freshOwners] of [...freshByModule.entries()].sort(([a], [b]) => compare(a, b))) {
    const existingOwners = existingByModule.get(mod) ?? [];
    const allOwners = [...freshOwners, ...existingOwners];
    const epics = new Set(allOwners.map(task => task.epicId));
    if (epics.size <= 1) continue;
    const crossEpicIds = new Set();
    const pairKey = (a, b) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);
    for (let i = 0; i < freshOwners.length; i++) {
      const left = freshOwners[i];
      for (let j = i + 1; j < freshOwners.length; j++) {
        const right = freshOwners[j];
        if (left.epicId !== right.epicId && !parallelSet.has(pairKey(left.id, right.id))) {
          crossEpicIds.add(left.id);
          crossEpicIds.add(right.id);
        }
      }
      if (existingOwners.length && !existingOwners.every(existing => ancestorMap.get(left.id)?.has(existing.id))) {
        for (const existing of existingOwners) {
          if (left.epicId !== existing.epicId && !parallelSet.has(pairKey(left.id, existing.id))) {
            crossEpicIds.add(left.id);
            crossEpicIds.add(existing.id);
          }
        }
      }
    }
    if (!crossEpicIds.size) continue;
    findings.push(
      finding(
        'blueprint_owner_ambiguous',
        `Модуль ${mod} не имеет однозначного владельца: в него пишут задачи разных эпиков (${[...epics].sort(compare).join(', ')})`,
        [...crossEpicIds],
      ),
    );
  }
  return findings;
}
/** Reject tasks whose write scope exceeds MAX_TASK_WRITE_PATHS or MAX_TASK_MODULES.
 * Integrator tasks (`owner === 'integrator'`) are exempt on shared integration files. */
export function taskScopeSizeFindings(tasks, alreadyOversized = new Set()) {
  const oversized = tasks
    .filter(task => {
      if (alreadyOversized.has(task.id)) return false;
      const rawPaths = task.writePaths ?? [];
      const paths = task.owner === 'integrator' ? rawPaths.filter(p => !isIntegratorExemptPath(p)) : rawPaths;
      const modules = new Set(paths.map(moduleOfWritePath).filter(Boolean));
      return paths.length > MAX_TASK_WRITE_PATHS || modules.size > MAX_TASK_MODULES;
    })
    .map(task => task.id);
  return oversized.length
    ? [
        finding(
          'split_required',
          `Слишком крупная задача: больше ${MAX_TASK_WRITE_PATHS} путей записи или больше ${MAX_TASK_MODULES} модулей; разделите задачу в чертеже`,
          oversized,
        ),
      ]
    : [];
}
export function ownerFindings(tasks) {
  const ids = tasks.filter(task => !FACTORY_ROLES.includes(task.owner)).map(task => task.id);
  return ids.length
    ? [finding('blueprint_owner_unknown', `owner задачи должен быть одной из ролей: ${FACTORY_ROLES.join(', ')}`, ids)]
    : [];
}
export function storedProject(spec) {
  return {
    schemaVersion: 1,
    projectId: LINT_PROJECT_ID,
    id: spec.id,
    root: spec.root,
    projectKey: 'blueprint-lint',
    title: spec.title,
    definitionOfDone: spec.definitionOfDone,
    constraints: spec.constraints,
    businessContext: spec.businessContext,
    architectureRefs: spec.architectureRefs,
    status: 'proposed',
    paused: false,
    revision: LINT_REVISION,
    createdAt: LINT_AT,
    updatedAt: LINT_AT,
    evidence: [],
    mappings: [],
  };
}
/** Measure each task through the real buildDirectorTaskInput (12000 UTF-8 bytes). */
export function taskInputFindings({ project, tasks, contracts = projectContracts, knownValues = [] }) {
  const oversized = [],
    invalid = [];
  for (const task of tasks) {
    const stored = {
      ...task,
      schemaVersion: 1,
      projectId: project.projectId,
      revision: LINT_REVISION,
      status: 'proposed',
      createdAt: LINT_AT,
      updatedAt: LINT_AT,
      evidence: [],
      mappings: [],
    };
    try {
      contracts.buildDirectorTaskInput({ project, task: stored }, { knownValues });
    } catch (error) {
      if (errorCode(error) === 'project_task_too_large') oversized.push(task.id);
      else invalid.push(task.id);
    }
  }
  const context = Buffer.byteLength(
    JSON.stringify([project.title, project.definitionOfDone, project.constraints, project.businessContext]),
  );
  const findings = [];
  if (oversized.length)
    findings.push(
      finding(
        'split_required',
        `Вход задачи превышает ${MAX_TASK_INPUT_BYTES} байт UTF-8 вместе с контекстом проекта (≈${context} байт); ` +
          'Kodo задачи не режет — разделите их в чертеже',
        oversized,
      ),
    );
  if (invalid.length)
    findings.push(finding('blueprint_spec_invalid', 'Вход задачи не прошёл проверку безопасности Director', invalid));
  return findings;
}
export function waveZeroFindings(spec, ancestors) {
  const declared = spec.milestones.some(m => m.id === FOUNDATION_ID) || spec.epics.some(e => e.id === FOUNDATION_ID);
  const epics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const wave = new Set(spec.tasks.filter(task => epics.has(task.epicId)).map(task => task.id));
  if (!declared || !wave.size)
    return [
      finding(
        'blueprint_wave0_missing',
        declared
          ? 'Волна 0 (foundation) не содержит задач'
          : 'Нет майлстоуна или эпика foundation (Волна 0: каркас, линтеры, стенд проверки, общие интерфейсы)',
      ),
    ];
  const findings = [];
  const bypassed = spec.tasks
    .filter(task => !wave.has(task.id) && ![...ancestors.get(task.id)].some(id => wave.has(id)))
    .map(task => task.id);
  if (bypassed.length)
    findings.push(
      finding('blueprint_wave0_bypassed', 'Задачи вне Волны 0 должны транзитивно зависеть от её задачи', bypassed),
    );
  const inverted = spec.tasks
    .filter(task => wave.has(task.id) && [...ancestors.get(task.id)].some(id => !wave.has(id)))
    .map(task => task.id);
  if (inverted.length)
    findings.push(finding('blueprint_wave0_order', 'Задачи Волны 0 не могут зависеть от задач вне неё', inverted));
  return findings;
}
/** Epic graph: X → Y when a task of epic X depends on a task of another epic Y.
 * Acyclic tasks can still form an epic cycle (A1 → B1 → A2 → B2), which the
 * Store rejects for wave projects (project_epic_cycle): epic gates could never
 * close in order. Each strongly connected group of epics is one finding; with
 * `fresh`, only groups containing one of those epics are reported. Dependencies
 * on unknown tasks are ignored (other rules report them).
 * @param {Array<{ id: string, epicId: string, dependsOn?: string[] }>} tasks
 * @param {{ fresh?: Set<string> }} [options] */
export function epicCycleFindings(tasks, { fresh } = {}) {
  const epicOf = new Map(tasks.map(task => [task.id, task.epicId]));
  const edges = new Map();
  for (const task of tasks)
    for (const dependency of task.dependsOn ?? []) {
      const target = epicOf.get(dependency);
      if (target === undefined || target === task.epicId) continue;
      edges.set(task.epicId, (edges.get(task.epicId) ?? new Set()).add(target));
    }
  const reach = new Map();
  for (const epic of edges.keys()) {
    const seen = new Set(),
      stack = [epic];
    while (stack.length)
      for (const next of edges.get(stack.pop()) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
    reach.set(epic, seen);
  }
  const findings = [],
    placed = new Set();
  for (const epic of [...edges.keys()].sort(compare)) {
    if (placed.has(epic) || !reach.get(epic).has(epic)) continue;
    const group = [...reach.get(epic)].filter(other => reach.get(other)?.has(epic)).sort(compare);
    for (const member of group) placed.add(member);
    if (fresh && !group.some(member => fresh.has(member))) continue;
    const members = new Set(group);
    const ids = tasks
      .filter(task => members.has(task.epicId))
      .filter(task => (task.dependsOn ?? []).some(id => members.has(epicOf.get(id)) && epicOf.get(id) !== task.epicId))
      .map(task => String(task.id));
    const shownEpics = group.slice(0, 20).join(', ') + (group.length > 20 ? ` и ещё ${group.length - 20}` : '');
    findings.push(
      finding(
        'blueprint_epic_cycle',
        `Эпики ${shownEpics} зависят друг от друга по кругу через задачи; ` +
          'перенесите задачи между эпиками или объедините эпики, чтобы граф эпиков стал ацикличным',
        ids,
      ),
    );
  }
  return findings;
}
/** Containers without children: a milestone with no epic, an epic with no task. The Store
 * rejects them for wave projects (project_container_empty): an empty epic never gets a gate,
 * so it and its milestone would stay `proposed`. One finding lists every empty container.
 * @param {{ milestones: Array<{ id: string }>, epics: Array<{ id: string, milestoneId: string }>,
 *   tasks: Array<{ epicId: string }> }} spec */
export function containerFindings({ milestones, epics, tasks }) {
  const parents = new Set(epics.map(epic => epic.milestoneId)),
    filled = new Set(tasks.map(task => task.epicId));
  const empty = [
    ...milestones.filter(milestone => !parents.has(milestone.id)).map(milestone => `майлстоун ${milestone.id}`),
    ...epics.filter(epic => !filled.has(epic.id)).map(epic => `эпик ${epic.id}`),
  ];
  if (!empty.length) return [];
  const shown = empty.slice(0, 20).join(', ') + (empty.length > 20 ? ` и ещё ${empty.length - 20}` : '');
  return [
    finding(
      'blueprint_container_empty',
      `Пустые контейнеры: ${shown}; в каждом майлстоуне нужен эпик, в каждом эпике — задача (или удалите контейнер)`,
    ),
  ];
}
export function interfaceFindings(spec, interfaces) {
  const fold = windowsLike(spec.root) ? value => value.toLowerCase() : value => value;
  const base = `${slashed(spec.root)}/.kodo/blueprint/`;
  const known = new Map((Array.isArray(interfaces) ? interfaces : []).map(item => [fold(base + item.path), item]));
  const missing = new Set(),
    stale = new Set();
  for (const task of spec.tasks)
    for (const ref of task.interfaceRefs) {
      const match = ref.kind === 'interface' ? known.get(fold(slashed(ref.path))) : undefined;
      if (!match) missing.add(task.id);
      else if (match.sha256 !== ref.sha256) stale.add(task.id);
    }
  const findings = [];
  if (missing.size)
    findings.push(
      finding(
        'blueprint_interface_missing',
        'interfaceRefs должны указывать на существующие .kodo/blueprint/interfaces/<module>.md (kind "interface")',
        [...missing],
      ),
    );
  if (stale.size)
    findings.push(
      finding('blueprint_interface_stale', 'sha256 в interfaceRefs не совпадает с текущим файлом интерфейса', [
        ...stale,
      ]),
    );
  return findings;
}
