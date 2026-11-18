// Project factory blueprint: a filesystem-first plan under <root>/.kodo/blueprint
// that Kodo checks and compiles into ProjectSpec v1. Reads are bounded and
// link-free; lint is pure and deterministic. No provider sessions, network or
// writes. Kodo never splits tasks itself: the main chat edits the blueprint.
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as projectContracts from './project-contracts.mjs';
import { scopesOverlap } from './contracts.mjs';
import { inside } from './toolchains.mjs';

export const BLUEPRINT_DIR = '.kodo/blueprint';
export const MAX_TASK_INPUT_BYTES = 12000;
export const FOUNDATION_ID = 'foundation';
export const FACTORY_ROLES = Object.freeze(['architect', 'developer', 'ui-qa', 'performance', 'security', 'reviewer']);
export const DEFAULT_EXECUTION = Object.freeze({ cadence: 'wave', integration: 'branch' });
export const REQUIRED_SECTIONS = Object.freeze([
  { title: 'Цель', aliases: ['цель', 'цели', 'goal', 'goals'] },
  { title: 'Модули', aliases: ['модули', 'карта модулей', 'modules', 'module map'] },
  { title: 'Стек', aliases: ['стек', 'технологический стек', 'stack', 'tech stack', 'technology stack'] },
  { title: 'Критерии готовности', aliases: ['критерии готовности', 'definition of done', 'acceptance criteria'] },
]);
export const BLUEPRINT_LIMITS = Object.freeze({
  project: 64 * 1024,
  spec: 16 * 1024 * 1024,
  interface: 64 * 1024,
  interfaces: 64,
  interfacesTotal: 1024 * 1024,
});

const MODULE = /^[a-z][a-z0-9-]{0,47}$/;
const ZERO_DIGEST = '0'.repeat(64);
const PAIR_CAP = 100;
// Stored-record stand-ins used only to measure the real Director task input.
// The maximal revision keeps the estimate conservative for later revisions.
const LINT_PROJECT_ID = '00000000-0000-4000-8000-000000000000';
const LINT_AT = '2000-01-01T00:00:00.000Z';
const LINT_REVISION = Number.MAX_SAFE_INTEGER;

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const isPlain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const slashed = value => value.replaceAll('\\', '/').replace(/\/+$/, '');
const windowsLike = value => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
const shown = value => JSON.stringify(String(value).slice(0, 80));

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
/** A finding never interpolates file contents; only ids, names and counts. */
export function finding(code, message, taskIds) {
  return taskIds ? { code, taskIds, message } : { code, message };
}

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

async function projectRoot(root) {
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
  const real = await projectRoot(root);
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

// ---- Markdown sections -------------------------------------------------------

function headingTitle(raw) {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^[\p{Extended_Pictographic}️\s]+/u, '')
    .replace(/^(?:\d+(?:\.\d+)*[.)]?|[ivx]+[.)])\s+/i, '')
    .replace(/[\s:.;—–-]+$/, '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ATX and setext headings outside fenced code, with whether each section
 * (until the next heading of the same or higher level) has any content. */
export function markdownHeadings(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        opener &&
        opener[1][0] === fence[0] &&
        opener[1].length >= fence.length &&
        !/\S/.test(line.slice(opener[0].length))
      )
        fence = null;
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (atx) headings.push({ level: atx[1].length, title: headingTitle(atx[2]), start: index, line: index });
    else if (/^ {0,3}(=+|-+)[ \t]*$/.test(line) && index > 0 && /\S/.test(lines[index - 1])) {
      const previous = headings.at(-1);
      if (!previous || previous.line !== index - 1)
        headings.push({
          level: line.trim()[0] === '=' ? 1 : 2,
          title: headingTitle(lines[index - 1]),
          start: index - 1,
          line: index,
        });
    }
  }
  return headings.map((heading, position) => {
    const next = headings.slice(position + 1).find(item => item.level <= heading.level);
    const body = lines.slice(heading.line + 1, next ? next.start : lines.length);
    return { level: heading.level, title: heading.title, hasContent: body.some(item => /\S/.test(item)) };
  });
}

function matchesSection(title, aliases) {
  return aliases.some(alias => title === alias || new RegExp(`^${alias}(?:[\\s:(—–-]|$)`, 'u').test(title));
}

function sectionFindings(markdown) {
  const headings = markdownHeadings(typeof markdown === 'string' ? markdown : '');
  const findings = [];
  for (const section of REQUIRED_SECTIONS) {
    const matches = headings.filter(heading => matchesSection(heading.title, section.aliases));
    if (!matches.length)
      findings.push(finding('blueprint_section_missing', `В PROJECT.md нет раздела «${section.title}»`));
    else if (!matches.some(heading => heading.hasContent))
      findings.push(finding('blueprint_section_empty', `Раздел «${section.title}» в PROJECT.md пуст`));
  }
  return findings;
}

// ---- ProjectSpec normalization and graph ------------------------------------

// The factory runs only wave/branch. Missing cadence/integration default to it;
// other fields (watchdog) are checked by the strict ProjectSpec parser itself.
function executionOf(spec) {
  if (!Object.hasOwn(spec, 'execution')) return { execution: { ...DEFAULT_EXECUTION }, findings: [] };
  const raw = spec.execution;
  const valid =
    isPlain(raw) &&
    Object.keys(raw).every(key => ['cadence', 'integration', 'watchdog'].includes(key)) &&
    (raw.cadence ?? 'wave') === 'wave' &&
    (raw.integration ?? 'branch') === 'branch';
  if (valid) return { execution: { ...DEFAULT_EXECUTION, ...raw }, findings: [] };
  return {
    execution: { ...DEFAULT_EXECUTION },
    findings: [
      finding(
        'blueprint_execution_invalid',
        'execution поддерживает только { cadence: "wave", integration: "branch" }',
      ),
    ],
  };
}

function errorCode(error) {
  if (typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code)) return error.code;
  throw error;
}

// The spec is normalized as is, `execution` included; an invalid execution is
// reported and replaced by the default so the remaining rules still run.
function normalizeFactory(spec, { contracts, knownValues }) {
  if (!isPlain(spec))
    return {
      spec: null,
      findings: [finding('blueprint_spec_invalid', 'spec.json должен быть объектом ProjectSpec v1')],
    };
  const { execution, findings } = executionOf(spec);
  try {
    return { spec: contracts.normalizeProjectSpec({ ...spec, execution }, { knownValues }), findings };
  } catch (error) {
    const code = errorCode(error);
    findings.push(
      finding('blueprint_spec_invalid', `ProjectSpec отклонён строгой проверкой (${code}); см. docs/PROJECTS.md`),
    );
    return { spec: null, findings };
  }
}

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
  const pairs = [];
  for (let i = 0; i < tasks.length; i++) {
    const left = tasks[i];
    for (const right of tasks.slice(i + 1)) {
      if (ancestors.get(left.id)?.has(right.id) || ancestors.get(right.id)?.has(left.id)) continue;
      if (scopesOverlap(left.writePaths, right.writePaths)) pairs.push([left.id, right.id]);
    }
    for (const other of others)
      if (!ancestors.get(left.id)?.has(other.id) && scopesOverlap(left.writePaths, other.writePaths))
        pairs.push([left.id, other.id]);
  }
  return pairs;
}

export function overlapFindings(pairs) {
  const visible = pairs.slice(0, PAIR_CAP);
  return visible.map((pair, index) => {
    const rest = index === visible.length - 1 && pairs.length > visible.length;
    return finding(
      'blueprint_parallel_overlap',
      `Задачи ${pair[0]} и ${pair[1]} могут идти параллельно, но их writePaths пересекаются` +
        (rest ? `; ещё пар: ${pairs.length - visible.length}` : ''),
      pair,
    );
  });
}

export function ownerFindings(tasks) {
  const ids = tasks.filter(task => !FACTORY_ROLES.includes(task.owner)).map(task => task.id);
  return ids.length
    ? [finding('blueprint_owner_unknown', `owner задачи должен быть одной из ролей: ${FACTORY_ROLES.join(', ')}`, ids)]
    : [];
}

function storedProject(spec) {
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

function waveZeroFindings(spec, ancestors) {
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

function interfaceFindings(spec, interfaces) {
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

function analyzeFactorySpec(spec, options = {}) {
  const { contracts = projectContracts, knownValues = [], interfaces = [], projectMarkdown = '' } = options;
  const base = normalizeFactory(spec, { contracts, knownValues });
  const findings = [...base.findings, ...sectionFindings(projectMarkdown)];
  if (!base.spec) return { spec: null, findings };
  const ancestors = taskAncestors(base.spec.tasks);
  findings.push(
    ...ownerFindings(base.spec.tasks),
    ...waveZeroFindings(base.spec, ancestors),
    ...containerFindings(base.spec),
    ...epicCycleFindings(base.spec.tasks),
    ...overlapFindings(parallelOverlaps(base.spec.tasks, { ancestors })),
    ...taskInputFindings({ project: storedProject(base.spec), tasks: base.spec.tasks, contracts, knownValues }),
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

async function resolveSource({ root, spec, interfaces }) {
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

/** Read, resolve and lint the blueprint. Returns the compiled ProjectSpec
 * (with execution) even when findings exist; ok is the only acceptance signal.
 * `specFile` optionally replaces .kodo/blueprint/spec.json. Nothing is written to disk.
 * @param {string} root
 * @param {{ contracts?: typeof projectContracts, knownValues?: string[], specFile?: string }} [options] */
export async function compileBlueprint(root, { contracts = projectContracts, knownValues = [], specFile } = {}) {
  let blueprint;
  try {
    blueprint = await readBlueprint(root, { specFile });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('blueprint_'))
      return { ok: false, spec: null, interfaces: [], findings: [finding(error.code, error.message)] };
    throw error;
  }
  const source = await resolveSource(blueprint);
  const analysis = analyzeFactorySpec(source.value, {
    contracts,
    knownValues,
    interfaces: blueprint.interfaces,
    projectMarkdown: blueprint.project.text,
  });
  const findings = [...source.findings, ...analysis.findings];
  return { ok: findings.length === 0, spec: analysis.spec, interfaces: blueprint.interfaces, findings };
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
