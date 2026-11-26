// Spec structure checks of the project factory blueprint
// (`project-blueprint.mjs`): Markdown sections, execution settings and the
// normalization of the factory spec with located schema errors.

import { DEFAULT_EXECUTION, REQUIRED_SECTIONS, finding, isPlain } from './project-blueprint-shared.mjs';

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
export function sectionFindings(markdown) {
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
export function errorCode(error) {
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
export function normalizeFactory(spec, { contracts, knownValues }) {
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
