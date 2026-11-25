// Project factory blueprint: a filesystem-first plan under <root>/.kodo/blueprint
// that Kodo checks and compiles into ProjectSpec v1. Reads are bounded and
// link-free; lint is pure and deterministic. No provider sessions, network or
// writes. Kodo never splits tasks itself: the main chat edits the blueprint.
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import * as projectContracts from './project-contracts.mjs';
import {
  isBroadContractScope,
  isExplicitContractScope,
  normalizeScopePath,
  scopeMatchesPath,
} from './cargo-workspace.mjs';
import { scopesOverlap } from './contracts.mjs';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';
import { inside } from './toolchains.mjs';

export const BLUEPRINT_DIR = '.kodo/blueprint';
export const MAX_TASK_INPUT_BYTES = 12000;
export const MAX_TASK_WRITE_PATHS = 24;
export const MAX_TASK_MODULES = 3;
export const FOUNDATION_ID = 'foundation';
export const FACTORY_ROLES = Object.freeze([
  'architect',
  'developer',
  'integrator',
  'ui-qa',
  'performance',
  'security',
  'reviewer',
]);
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

// ---- Locating a strict ProjectSpec refusal ------------------------------------
// The strict parser reports only a code. Each record of the blueprint is checked alone inside a
// minimal valid spec, then field by field against a valid sample, to name what it rejects.

const PROBE_CRITERION = { id: 'probe', text: 'Probe criterion', evidenceKinds: ['acceptance'] };
const PROBE = {
  spec: {
    schemaVersion: 1,
    id: 'probe',
    root: '/probe',
    title: 'Probe',
    definitionOfDone: [PROBE_CRITERION],
    constraints: [],
    businessContext: '',
    architectureRefs: [],
  },
  milestone: { id: 'probe-milestone', title: 'Probe', acceptance: [PROBE_CRITERION], releaseRequired: false },
  epic: { id: 'probe-epic', milestoneId: 'probe-milestone', title: 'Probe', acceptance: [PROBE_CRITERION] },
  task: {
    id: 'probe-task',
    epicId: 'probe-epic',
    title: 'Probe',
    description: 'Probe',
    owner: 'developer',
    dependsOn: [],
    writePaths: ['probe'],
    acceptance: [PROBE_CRITERION],
    interfaceRefs: [],
    priority: 50,
    userValue: 1,
    risk: 1,
    estimatedEffort: 1,
    riskApprovalRequired: false,
  },
};
const LABELS = { milestone: 'майлстоун', epic: 'эпик', task: 'задача' };
const nameOf = value => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : null);
const children = ['milestones', 'epics', 'tasks'];
// The longest list a ProjectSpec accepts (project-contracts MAX_ITEMS): longer is project_limit.
const LIST_LIMIT = 1000;

// A minimal valid spec around one record of `kind`; its parent and child are probe records. The
// task keeps its own `dependsOn` (its shape and repeats are its own) with a probe task for each
// other id it names; which of them exist is checked across records.
function probeSpec(kind, record, execution) {
  const milestone =
    kind === 'milestone' ? record : { ...PROBE.milestone, ...(kind === 'epic' ? { id: record.milestoneId } : {}) };
  const epic =
    kind === 'epic'
      ? record
      : { ...PROBE.epic, milestoneId: milestone.id, ...(kind === 'task' ? { id: record.epicId } : {}) };
  const task = kind === 'task' ? record : { ...PROBE.task, epicId: epic.id };
  const named = kind === 'task' && Array.isArray(record.dependsOn) ? record.dependsOn : [];
  const others = [...new Set(named.filter(id => typeof id === 'string' && id !== record.id))];
  const stubs = others.map((id, index) => ({ ...PROBE.task, id, epicId: epic.id, writePaths: [`probe-${index}`] }));
  return {
    ...(kind === 'spec' ? record : PROBE.spec),
    execution,
    milestones: [milestone],
    epics: [epic],
    tasks: [task, ...stubs],
  };
}

// The field of one record the strict parser refuses: `{detail, field?}`, or null.
function fieldOf(kind, record, accepts, execution) {
  const sample = PROBE[kind];
  if (!isPlain(record)) return { detail: 'не объект' };
  const unknown = Object.keys(record).find(key => !Object.hasOwn(sample, key));
  if (unknown !== undefined)
    return { detail: `лишнее поле ${nameOf(unknown) ?? '(имя вне формата)'}`, field: nameOf(unknown) };
  const missing = Object.keys(sample).find(key => !Object.hasOwn(record, key));
  if (missing) return { detail: `нет поля ${missing}`, field: missing };
  // A task that names itself is visible only on its own record: a probe sample has another id.
  if (kind === 'task' && Array.isArray(record.dependsOn) && record.dependsOn.includes(record.id))
    return { detail: 'поле dependsOn (ссылка на саму задачу)', field: 'dependsOn' };
  const field = Object.keys(sample).find(
    key => !accepts(probeSpec(kind, { ...sample, [key]: record[key] }, execution)),
  );
  return field ? { detail: `поле ${field}`, field } : null;
}

const pathOf = (base, field) => (field ? (base ? `${base}.${field}` : field) : base);

// Links between records (parents, dependencies, unique ids) that each record alone cannot show.
function referenceOf(spec) {
  const place = (key, index, record, detail, field) => ({
    where: `${LABELS[key.slice(0, -1)]} ${nameOf(record.id) ?? ''}`.trim(),
    detail,
    path: `${key}[${index}].${field}`,
    ...(key === 'tasks' && nameOf(record.id) ? { taskId: record.id } : {}),
  });
  for (const key of children) {
    const seen = new Set();
    for (const [index, record] of spec[key].entries()) {
      if (seen.has(record.id)) return place(key, index, record, 'повторяющийся id', 'id');
      seen.add(record.id);
    }
  }
  const ids = key => new Set(spec[key].map(record => record.id));
  const milestones = ids('milestones'),
    epics = ids('epics'),
    tasks = ids('tasks');
  const missing = (label, value) => `(нет ${label}${nameOf(value) ? ` ${value}` : ''})`;
  for (const [index, epic] of spec.epics.entries())
    if (!milestones.has(epic.milestoneId))
      return place('epics', index, epic, `поле milestoneId ${missing('майлстоуна', epic.milestoneId)}`, 'milestoneId');
  for (const [index, task] of spec.tasks.entries()) {
    if (!epics.has(task.epicId))
      return place('tasks', index, task, `поле epicId ${missing('эпика', task.epicId)}`, 'epicId');
    const ghost = task.dependsOn.find(id => !tasks.has(id));
    if (ghost !== undefined)
      return place('tasks', index, task, `поле dependsOn ${missing('задачи', ghost)}`, 'dependsOn');
  }
  return null;
}

// A list longer than the parser accepts, found without parsing any record.
function overflowOf(spec) {
  const key = children.find(name => Array.isArray(spec[name]) && spec[name].length > LIST_LIMIT);
  return key ? { where: 'spec.json', detail: `поле ${key} (больше ${LIST_LIMIT} записей)`, path: key } : null;
}

// Where the strict parser refused `spec`: `{where, detail, path, taskId?}` or null when not found.
function locateSpecError(spec, execution, accepts) {
  if (!accepts(probeSpec('spec', PROBE.spec, execution)))
    return { where: 'spec.json', detail: 'поле execution', path: 'execution' };
  const missing = children.find(key => !Array.isArray(spec[key]));
  if (missing) return { where: 'spec.json', detail: `поле ${missing}`, path: missing };
  const header = Object.fromEntries(
    Object.entries(spec).filter(([key]) => !children.includes(key) && key !== 'execution'),
  );
  const records = [
    ['spec', null, header],
    ...children.flatMap(key => spec[key].map((record, index) => [key.slice(0, -1), `${key}[${index}]`, record])),
  ];
  for (const [kind, base, record] of records) {
    if (isPlain(record) && accepts(probeSpec(kind, record, execution))) continue;
    const id = kind === 'spec' ? null : nameOf(record?.id);
    const field = fieldOf(kind, record, accepts, execution);
    return {
      where: kind === 'spec' ? 'spec.json' : `${LABELS[kind]} ${id ?? '(id вне формата)'}`,
      detail: field?.detail ?? null,
      path: pathOf(base, field?.field),
      ...(kind === 'task' && id ? { taskId: id } : {}),
    };
  }
  return referenceOf(spec);
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
    const accepts = candidate => {
      try {
        contracts.normalizeProjectSpec(candidate, { knownValues });
        return true;
      } catch {
        return false;
      }
    };
    // An overlong list is named without parsing a record. A refusal for a secret or a size limit is
    // not probed: the safety scan may have stopped before the data a probe would name.
    const cycle = { where: 'граф задач', detail: 'цикл в dependsOn', path: 'tasks[].dependsOn' };
    /** @type {{ where: string, detail: string | null, path: string, taskId?: string } | null} */
    const place =
      overflowOf(spec) ??
      (['project_unsafe', 'project_limit'].includes(code)
        ? null
        : (locateSpecError(spec, execution, accepts) ?? (code === 'project_dag' ? cycle : null)));
    const bare = `ProjectSpec отклонён строгой проверкой (${code}); см. docs/PROJECTS.md`;
    const located =
      place &&
      `ProjectSpec отклонён строгой проверкой (${code}): ${place.where}${place.detail ? `, ${place.detail}` : ''}; путь ${place.path}; см. docs/PROJECTS.md`;
    const taskIds = place?.taskId ? [place.taskId] : undefined;
    // A located message that would name a known value falls back to the bare code.
    let safe = Boolean(located);
    try {
      if (safe) contracts.assertDirectorSafe({ located, taskIds: taskIds ?? [] }, { knownValues });
    } catch {
      safe = false;
    }
    findings.push(finding('blueprint_spec_invalid', safe ? located : bare, safe ? taskIds : undefined));
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

const RUST_CONTRACT_CRATE_MIN = 3;
const CONTRACT_CRATE_NAME = /(?:^|[-_])contracts$/i;

function normalizeRelScope(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function crateFromWritePath(raw) {
  const cleaned = normalizeRelScope(raw);
  if (!cleaned) return null;
  const cratesMatch = /^((?:[^/*?[{]+\/)*crates\/([A-Za-z0-9][A-Za-z0-9_-]*))(?:\/|$)/.exec(cleaned);
  if (cratesMatch) return { name: cratesMatch[2], root: cratesMatch[1] };
  const cargoMatch = /^([^/*?[{]+(?:\/[^/*?[{]+)*)\/Cargo\.toml$/.exec(cleaned);
  if (cargoMatch) {
    const root = cargoMatch[1];
    return { name: root.split('/').at(-1), root };
  }
  return null;
}

function isRustBlueprint(spec, projectMarkdown, architecturePolicy) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return true;
  if (typeof projectMarkdown === 'string' && /\b(?:rust|cargo)\b/i.test(projectMarkdown)) return true;
  if (
    spec.tasks.some(task =>
      (task.writePaths ?? []).some(scope => /(?:^|\/)Cargo\.toml$|\.rs$/i.test(String(scope).replaceAll('\\', '/'))),
    )
  )
    return true;
  const meta = [spec.title, spec.businessContext, ...(spec.constraints ?? [])].filter(Boolean).join('\n');
  return /\b(?:rust|cargo)\b/i.test(meta);
}

function linesOutsideCodeFences(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
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
    out.push(line);
  }
  return out;
}

const strictDeclRe = (key, valueClass) =>
  new RegExp(
    `^ {0,3}(?:[-*]\\s+)?${key}\\s*:\\s*(?:\`(${valueClass})\`|"(${valueClass})"|'(${valueClass})'|(${valueClass}))\\s*$`,
  );
const CONTRACT_DECL_RE = strictDeclRe('contractCrate', '[A-Za-z0-9][A-Za-z0-9_./-]*');
const WORKSPACE_DECL_RE = strictDeclRe('workspaceRoot', '\\.|[A-Za-z0-9][A-Za-z0-9_./-]*');
const ROOT_PACKAGE_DECL_RE = strictDeclRe('rootPackage', '\\.|[A-Za-z0-9][A-Za-z0-9_./-]*');

function cleanDeclaredPath(raw) {
  const cleaned = raw
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (!cleaned || /^(?:none|no|false)$/i.test(cleaned)) return null;
  if (cleaned !== '.' && cleaned.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return cleaned;
}

function collectStrictDeclarations(sources, pattern) {
  const tokens = new Set();
  for (const source of sources) {
    for (const line of linesOutsideCodeFences(source)) {
      const match = pattern.exec(line);
      if (!match) continue;
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
      const cleaned = cleanDeclaredPath(raw);
      if (cleaned) tokens.add(cleaned);
    }
  }
  return tokens;
}

function declaredContractTokens(spec, projectMarkdown) {
  return collectStrictDeclarations([projectMarkdown, ...(spec.constraints ?? [])], CONTRACT_DECL_RE);
}

function declaredRootPackages(spec, projectMarkdown) {
  const roots = new Set();
  for (const token of collectStrictDeclarations([projectMarkdown, ...(spec.constraints ?? [])], ROOT_PACKAGE_DECL_RE)) {
    roots.add(token === '.' || token === 'Cargo.toml' ? '' : token.replace(/\/Cargo\.toml$/, ''));
  }
  return roots;
}

function declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, allCrates) {
  const roots = new Set();
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') roots.add('');
  for (const token of collectStrictDeclarations([projectMarkdown, ...(spec.constraints ?? [])], WORKSPACE_DECL_RE)) {
    roots.add(token === '.' || token === 'Cargo.toml' ? '' : token.replace(/\/Cargo\.toml$/, ''));
  }
  for (const task of spec.tasks) {
    for (const raw of task.writePaths ?? []) {
      const cleaned = normalizeRelScope(raw);
      if (cleaned === 'Cargo.toml') roots.add('');
      else if (cleaned.endsWith('/Cargo.toml')) {
        const dir = cleaned.slice(0, -'/Cargo.toml'.length);
        if ([...allCrates.keys()].some(crateRoot => crateRoot !== dir && crateRoot.startsWith(`${dir}/`)))
          roots.add(dir);
      }
    }
  }
  return roots;
}

function taskCreatesCompilableContractCrate(task, contractRoot) {
  let coversManifest = false;
  let coversSource = false;
  const manifestPath = contractRoot ? `${contractRoot}/Cargo.toml` : 'Cargo.toml';
  const libPath = contractRoot ? `${contractRoot}/src/lib.rs` : 'src/lib.rs';
  const srcPrefix = contractRoot ? `${contractRoot}/src/` : 'src/';
  for (const rawScope of task.writePaths ?? []) {
    if (!isExplicitContractScope(rawScope, contractRoot)) continue;
    const scope = normalizeScopePath(rawScope);
    if (scopeMatchesPath(scope, manifestPath)) coversManifest = true;
    if (scopeMatchesPath(scope, libPath) || (scope.startsWith(srcPrefix) && /\.rs$/i.test(scope))) coversSource = true;
  }
  return coversManifest && coversSource;
}

function broadContractScopeFindings(spec, contractRoots) {
  if (!contractRoots.size) return [];
  const offending = new Set();
  for (const task of spec.tasks) {
    for (const scope of task.writePaths ?? []) {
      for (const contractRoot of contractRoots) {
        if (isBroadContractScope(scope, contractRoot)) offending.add(task.id);
      }
    }
  }
  if (!offending.size) return [];
  return [
    finding(
      'contract_scope_too_broad',
      'Путь записи задачи накрывает защищённый контрактный крейт слишком широкой маской; ' +
        'укажите конкретный каталог модуля или явно назовите каталог контрактного крейта в задаче контракта',
      [...offending].sort(compare),
    ),
  ];
}

function ownerWorkspaceOf(crateRoot, sortedWorkspaceRoots) {
  return sortedWorkspaceRoots.find(wsRoot =>
    wsRoot === '' ? true : crateRoot === wsRoot || crateRoot.startsWith(`${wsRoot}/`),
  );
}

function normalizePackageNames(raw) {
  const map = new Map();
  const entries = raw instanceof Map ? [...raw.entries()] : isPlain(raw) ? Object.entries(raw) : [];
  for (const [dir, name] of entries) {
    if (typeof dir !== 'string' || typeof name !== 'string' || !name.trim()) continue;
    const cleaned = dir === '' || dir === '.' ? '' : normalizeRelScope(dir);
    map.set(cleaned, name.trim());
  }
  return map;
}

function selectContractRootsForWorkspace({
  wsRoot,
  wsCrates,
  workspaceRoots,
  explicitTokens,
  architecturePolicy,
  actualNames,
}) {
  const roots = new Set();
  const isRustV2Policy =
    wsRoot === '' && architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust';
  if (isRustV2Policy) {
    const policyNames = new Set(
      Array.isArray(architecturePolicy.contractCrates)
        ? architecturePolicy.contractCrates.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim())
        : [],
    );
    for (const [root, name] of wsCrates.entries()) {
      if (policyNames.has(name)) roots.add(root);
    }
    for (const token of explicitTokens) {
      const dir = token === '.' ? '' : token;
      const pkgName = actualNames?.get(dir);
      if (pkgName && policyNames.has(pkgName) && ownerWorkspaceOf(dir, workspaceRoots) === wsRoot) roots.add(dir);
    }
    return roots;
  }
  for (const [root, name] of wsCrates.entries()) {
    if (explicitTokens.has(root) || explicitTokens.has(name) || CONTRACT_CRATE_NAME.test(name)) roots.add(root);
  }
  for (const token of explicitTokens) {
    if (token.includes('/') && ownerWorkspaceOf(token, workspaceRoots) === wsRoot) roots.add(token);
  }
  return roots;
}

function taskCoversManifest(task, wsRoot) {
  const manifestPath = wsRoot ? `${wsRoot}/Cargo.toml` : 'Cargo.toml';
  return (task.writePaths ?? []).some(rawScope => {
    const scope = normalizeScopePath(rawScope);
    return Boolean(scope) && (scope === manifestPath || isExplicitContractScope(scope, wsRoot, manifestPath));
  });
}

function hasRootPackageMember(spec, wsRoot, explicitRootPackages = new Set(), explicitTokens = new Set()) {
  if (explicitRootPackages.has(wsRoot)) return true;
  if (explicitTokens.has(wsRoot === '' ? '.' : wsRoot)) return true;
  const srcDir = wsRoot ? `${wsRoot}/src` : 'src';
  const libPath = `${srcDir}/lib.rs`;
  const mainPath = `${srcDir}/main.rs`;
  let hasManifest = false;
  let hasRustSrc = false;
  for (const task of spec.tasks) {
    if (taskCoversManifest(task, wsRoot)) hasManifest = true;
    for (const rawScope of task.writePaths ?? []) {
      const scope = normalizeScopePath(rawScope);
      if (!scope) continue;
      if (scope === libPath || scope === mainPath || (scope.startsWith(`${srcDir}/`) && /\.rs$/i.test(scope))) {
        hasRustSrc = true;
      }
    }
  }
  return hasManifest && hasRustSrc;
}

function waveZeroPolicyFindings({ waveZeroTasks, ancestors, architecturePolicy, requiredWorkspaces }) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return [];
  const policyTasks = waveZeroTasks.filter(task =>
    (task.writePaths ?? []).some(scope => isExplicitContractScope(scope, '', 'architecture.policy.json')),
  );
  if (!policyTasks.length) {
    return [
      finding(
        'architecture_policy_required',
        'Для Rust workspace с ≥ 3 крейтами Волна 0 (foundation) должна содержать задачу, ' +
          'создающую architecture.policy.json (в её writePaths), иначе гейты при architecture.enabled будут заблокированы',
      ),
    ];
  }
  const policyIds = new Set(policyTasks.map(task => task.id));
  const unordered = new Set(
    waveZeroTasks
      .filter(
        task =>
          !policyIds.has(task.id) &&
          !policyTasks.some(
            pt =>
              ancestors.get(task.id)?.has(pt.id) || (pt.epicId === task.epicId && ancestors.get(pt.id)?.has(task.id)),
          ),
      )
      .map(task => task.id),
  );
  // At the first epic gate carrying architecture.policy.json, the workspace manifest and
  // compilable contract crate must already exist (same task, same epic, or an ancestor task).
  for (const pt of policyTasks) {
    const ptAncestors = ancestors.get(pt.id) ?? new Set();
    const available = waveZeroTasks.filter(
      task => task.id === pt.id || task.epicId === pt.epicId || ptAncestors.has(task.id),
    );
    for (const { wsRoot, wsContracts } of requiredWorkspaces) {
      const hasManifest = available.some(task => taskCoversManifest(task, wsRoot));
      const hasContract = available.some(task =>
        [...wsContracts].some(contractRoot => taskCreatesCompilableContractCrate(task, contractRoot)),
      );
      if (!hasManifest || !hasContract) unordered.add(pt.id);
    }
  }
  if (!unordered.size) return [];
  return [
    finding(
      'architecture_policy_order',
      'Остальные задачи Волны 0 (foundation) должны зависеть от задачи, создающей architecture.policy.json, ' +
        'или совпадать с ней, а к гейту эпика с политикой уже должны существовать Cargo.toml и контрактный крейт',
      [...unordered].sort(compare),
    ),
  ];
}

/** Multi-crate Rust workspaces (>= 3 crates sharing a workspace root) must create a compilable
 * contract crate (`Cargo.toml` + `src/**`) and `architecture.policy.json` in Wave 0. */
export function rustContractCrateFindings(
  spec,
  projectMarkdown = '',
  architecturePolicy = null,
  ancestors = null,
  packageNames = null,
) {
  if (!isRustBlueprint(spec, projectMarkdown, architecturePolicy)) return [];
  const actualNames = normalizePackageNames(packageNames);
  const allCrates = new Map();
  for (const task of spec.tasks) {
    for (const scope of task.writePaths ?? []) {
      const crate = crateFromWritePath(scope);
      if (crate) allCrates.set(crate.root, actualNames.get(crate.root) ?? crate.name);
    }
  }
  const explicitTokens = declaredContractTokens(spec, projectMarkdown);
  const explicitRootPackages = declaredRootPackages(spec, projectMarkdown);
  const workspaceRoots = [...declaredWorkspaceRoots(spec, projectMarkdown, architecturePolicy, allCrates)].sort(
    (a, b) => b.length - a.length || compare(a, b),
  );
  const byWorkspace = new Map(workspaceRoots.map(wsRoot => [wsRoot, new Map()]));
  for (const [crateRoot, crateName] of allCrates.entries()) {
    const ownerWs = ownerWorkspaceOf(crateRoot, workspaceRoots);
    if (ownerWs !== undefined && crateRoot !== ownerWs) byWorkspace.get(ownerWs).set(crateRoot, crateName);
  }
  for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
    if (
      !wsCrates.has(wsRoot) &&
      (actualNames.has(wsRoot) || hasRootPackageMember(spec, wsRoot, explicitRootPackages, explicitTokens))
    ) {
      wsCrates.set(wsRoot, actualNames.get(wsRoot) ?? (wsRoot ? wsRoot.split('/').at(-1) : spec.id || 'root'));
    }
  }

  const allContractRoots = new Set();
  if (workspaceRoots.length) {
    for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
      for (const root of selectContractRootsForWorkspace({
        wsRoot,
        wsCrates,
        workspaceRoots,
        explicitTokens,
        architecturePolicy,
        actualNames,
      }))
        allContractRoots.add(root);
    }
  } else {
    for (const [root, name] of allCrates.entries()) {
      if (explicitTokens.has(root) || explicitTokens.has(name) || CONTRACT_CRATE_NAME.test(name))
        allContractRoots.add(root);
    }
    for (const token of explicitTokens) {
      if (token.includes('/')) allContractRoots.add(token);
    }
  }
  const findings = [...broadContractScopeFindings(spec, allContractRoots)];
  if (!workspaceRoots.length) return findings;

  const waveZeroEpics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const waveZeroTasks = spec.tasks.filter(task => waveZeroEpics.has(task.epicId));
  if (!waveZeroTasks.length) return findings;

  const requiredWorkspaces = [];
  let missingContract = false;
  for (const [wsRoot, wsCrates] of byWorkspace.entries()) {
    if (wsCrates.size < RUST_CONTRACT_CRATE_MIN) continue;
    const wsContracts = selectContractRootsForWorkspace({
      wsRoot,
      wsCrates,
      workspaceRoots,
      explicitTokens,
      architecturePolicy,
      actualNames,
    });
    requiredWorkspaces.push({ wsRoot, wsContracts });
    const satisfied = waveZeroTasks.some(task =>
      [...wsContracts].some(contractRoot => taskCreatesCompilableContractCrate(task, contractRoot)),
    );
    if (!satisfied) missingContract = true;
  }
  if (missingContract) {
    findings.push(
      finding(
        'contract_crate_required',
        'Для Rust workspace с ≥ 3 крейтами Волна 0 (foundation) должна содержать задачу, ' +
          'создающую компилируемый контрактный крейт (Cargo.toml и src/** в crates/<name>-contracts ' +
          'или явно объявленном контрактном крейте), защищённый через contractCrates в architecture.policy.json',
      ),
    );
  }
  if (requiredWorkspaces.length) {
    const resolvedAncestors = ancestors ?? taskAncestors(spec.tasks);
    findings.push(
      ...waveZeroPolicyFindings({
        waveZeroTasks,
        ancestors: resolvedAncestors,
        architecturePolicy,
        requiredWorkspaces,
      }),
    );
  }
  return findings;
}

function isRustWriteScope(rawScope) {
  const scope = normalizeRelScope(rawScope);
  if (!scope) return false;
  return /(?:^|[/{,])(?:Cargo\.toml|[^/{},]+\.rs)(?:[},]|$)/i.test(scope);
}

function isRustToolchainBlueprint(spec, architecturePolicy, { hasCommittedCargoManifest = false } = {}) {
  if (architecturePolicy?.schemaVersion === 2 && architecturePolicy?.language === 'rust') return true;
  if (hasCommittedCargoManifest) return true;
  return spec.tasks.some(task => (task.writePaths ?? []).some(isRustWriteScope));
}

/** Wave 0 for Rust blueprints must include `rust-toolchain.toml` (exact `channel = "1.x.y"`
 * with `clippy` and `rustfmt` components) in its writePaths unless a valid committed file already exists. */
export function rustToolchainFindings(
  spec,
  _projectMarkdown = '',
  architecturePolicy = null,
  { hasRustToolchain = false, hasCommittedCargoManifest = false } = {},
) {
  if (hasRustToolchain) return [];
  const waveZeroEpics = new Set(
    spec.epics.filter(epic => epic.id === FOUNDATION_ID || epic.milestoneId === FOUNDATION_ID).map(epic => epic.id),
  );
  const waveZeroTasks = spec.tasks.filter(task => waveZeroEpics.has(task.epicId));
  if (!waveZeroTasks.length) return [];
  if (!isRustToolchainBlueprint(spec, architecturePolicy, { hasCommittedCargoManifest })) return [];
  const coversToolchain = waveZeroTasks.some(task =>
    (task.writePaths ?? []).some(rawScope => {
      const scope = normalizeScopePath(rawScope);
      return (
        Boolean(scope) &&
        (scope === 'rust-toolchain.toml' ||
          scope.endsWith('/rust-toolchain.toml') ||
          isExplicitContractScope(scope, '', 'rust-toolchain.toml'))
      );
    }),
  );
  if (coversToolchain) return [];
  return [
    finding(
      'rust_toolchain_required',
      'Для Rust-проекта Волна 0 (foundation) должна содержать задачу с rust-toolchain.toml ' +
        '(точная версия channel = "1.x.y", компоненты clippy и rustfmt) в writePaths',
    ),
  ];
}

function analyzeFactorySpec(spec, options = {}) {
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
    ...rustContractCrateFindings(base.spec, projectMarkdown, architecturePolicy, ancestors, packageNames),
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

async function readOptionalArchitecturePolicy(root) {
  try {
    const file = await readBoundedFile(path.join(root, 'architecture.policy.json'), BLUEPRINT_LIMITS.spec);
    const parsed = JSON.parse(file.text);
    return isPlain(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readCommittedRootEntry(root, file) {
  try {
    const top = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (top.code !== 0 || typeof top.stdout !== 'string' || !(await sameDirectory(top.stdout.trim(), root)))
      return null;
    const ls = await execute('git', ['ls-tree', '-z', 'HEAD', '--', file], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (ls.code !== 0 || typeof ls.stdout !== 'string') return null;
    const rows = ls.stdout.split('\0').filter(Boolean);
    if (rows.length !== 1) return null;
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(rows[0]);
    if (!match || match[3] !== file) return null;
    return { oid: match[2] };
  } catch {
    return null;
  }
}

async function hasCommittedCargoManifest(root) {
  return Boolean(await readCommittedRootEntry(root, 'Cargo.toml'));
}

async function readOptionalRustToolchain(root) {
  const entry = await readCommittedRootEntry(root, 'rust-toolchain.toml');
  if (!entry) return false;
  try {
    const sizeOut = await execute('git', ['cat-file', '-s', entry.oid], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    const size = Number(sizeOut.stdout?.trim());
    if (sizeOut.code !== 0 || !Number.isSafeInteger(size) || size < 0 || size > BLUEPRINT_LIMITS.project) return false;
    const blob = await execute('git', ['cat-file', 'blob', entry.oid], {
      cwd: root,
      env: workerEnvironment(),
      rawOutput: true,
      allowFailure: true,
      timeoutMs: 10000,
    });
    if (blob.code !== 0 || typeof blob.stdout !== 'string' || Buffer.byteLength(blob.stdout) > BLUEPRINT_LIMITS.project)
      return false;
    const doc = parseToml(blob.stdout);
    const tc = /** @type {Record<string, any> | null} */ (isPlain(doc?.toolchain) ? doc.toolchain : null);
    const channel = typeof tc?.channel === 'string' ? tc.channel.trim() : '';
    const exactChannel = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(channel);
    const components = Array.isArray(tc?.components) ? tc.components : [];
    return exactChannel && components.includes('clippy') && components.includes('rustfmt');
  } catch {
    return false;
  }
}

async function readOptionalCargoPackageNames(root, specValue, projectMarkdown) {
  const dirs = new Set(['']);
  if (isPlain(specValue) && Array.isArray(specValue.tasks)) {
    for (const task of specValue.tasks) {
      if (!isPlain(task) || !Array.isArray(task.writePaths)) continue;
      for (const scope of task.writePaths) {
        if (typeof scope !== 'string') continue;
        const crate = crateFromWritePath(scope);
        if (crate) dirs.add(crate.root);
      }
    }
    for (const token of declaredContractTokens(specValue, projectMarkdown)) {
      if (token.includes('/')) dirs.add(token);
    }
  }
  const names = new Map();
  for (const dir of dirs) {
    if (dir && dir.split('/').some(part => !part || part === '.' || part === '..' || /[*?[{]/.test(part))) continue;
    const target = dir ? path.join(root, ...dir.split('/'), 'Cargo.toml') : path.join(root, 'Cargo.toml');
    if (!inside(root, target)) continue;
    try {
      const file = await readBoundedFile(target, BLUEPRINT_LIMITS.project);
      const doc = parseToml(file.text);
      const pkg = /** @type {Record<string, any> | null} */ (isPlain(doc?.package) ? doc.package : null);
      const pkgName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
      if (pkgName) names.set(dir, pkgName);
    } catch {
      /* Missing or unreadable manifest: fall back to directory name. */
    }
  }
  return names;
}

/** Read, resolve and lint the blueprint. Returns the compiled ProjectSpec
 * (with execution) even when findings exist; ok is the only acceptance signal.
 * `specFile` optionally replaces .kodo/blueprint/spec.json. Nothing is written to disk.
 * @param {string} root
 * @param {{ contracts?: typeof projectContracts, knownValues?: string[], specFile?: string, architecturePolicy?: Record<string, any> | null, packageNames?: Map<string, string> | Record<string, string> | null, hasRustToolchain?: boolean, hasCommittedCargoManifest?: boolean }} [options] */
export async function compileBlueprint(
  root,
  {
    contracts = projectContracts,
    knownValues = [],
    specFile,
    architecturePolicy,
    packageNames,
    hasRustToolchain,
    hasCommittedCargoManifest: committedCargo,
  } = {},
) {
  let blueprint;
  try {
    blueprint = await readBlueprint(root, { specFile });
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('blueprint_'))
      return { ok: false, spec: null, interfaces: [], findings: [finding(error.code, error.message)] };
    throw error;
  }
  const source = await resolveSource(blueprint);
  const policy =
    architecturePolicy === undefined ? await readOptionalArchitecturePolicy(blueprint.root) : architecturePolicy;
  const resolvedPackageNames =
    packageNames === undefined
      ? await readOptionalCargoPackageNames(blueprint.root, source.value, blueprint.project.text)
      : packageNames;
  const resolvedToolchain =
    hasRustToolchain === undefined ? await readOptionalRustToolchain(blueprint.root) : Boolean(hasRustToolchain);
  const resolvedCommittedCargo =
    committedCargo === undefined ? await hasCommittedCargoManifest(blueprint.root) : Boolean(committedCargo);
  const analysis = analyzeFactorySpec(source.value, {
    contracts,
    knownValues,
    interfaces: blueprint.interfaces,
    projectMarkdown: blueprint.project.text,
    architecturePolicy: policy,
    packageNames: resolvedPackageNames,
    hasRustToolchain: resolvedToolchain,
    hasCommittedCargoManifest: resolvedCommittedCargo,
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
