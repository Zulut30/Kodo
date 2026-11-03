import { redact } from './security.mjs';

const text = (value, max, secrets) => typeof value === 'string' ? Array.from(redact(value, secrets)).slice(0, max).join('') : '';
const strings = values => Array.isArray(values) ? values.join('\n') : typeof values === 'string' ? values : '';

export const maxTaskContractBytes = 12000;
/** Mandatory data is lossless. Only optional project/dependency context may be
 * summarized. Saved oversized contracts use an explicit immutable full file. */
export function taskContract(task, secrets = {}) {
  return redact(Object.fromEntries(['id', 'role', 'description', 'writePaths', 'acceptance', 'interfaces', 'constraints', 'dependsOn', 'parallel'].filter(key => task[key] !== undefined).map(key => [key, task[key]])), secrets);
}
export function validateTaskContract(task) {
  const bytes = Buffer.byteLength(JSON.stringify(taskContract(task)), 'utf8');
  if (bytes > maxTaskContractBytes) throw Object.assign(new Error(`Node ${task.id} mandatory contract is ${bytes} UTF-8 bytes (limit ${maxTaskContractBytes}); split/decompose it into small cohesive module tasks with complete acceptance criteria.`), { code: 'task_contract_too_large' });
  return task;
}

/** Deliberate allowlist: never serialize a run, analysis, research body or a
 * previous request. The pinned policy and optional tool guidance are separate. */
export function buildTaskContext(run, task, { contractPath, secrets = {} } = {}) {
  const core = taskContract(task, secrets);
  const oversized = Buffer.byteLength(JSON.stringify(core), 'utf8') > maxTaskContractBytes;
  if (oversized && !contractPath) validateTaskContract(task);
  const dependencies = (task.dependsOn || []).slice(0, 20).map(id => {
    const node = run.nodes?.[id], planned = run.plan?.tasks?.find(t => t.id === id);
    return { id: text(id, 100, secrets), status: text(node?.status, 40, secrets), headSha: text(node?.headSha, 64, secrets), summary: text(node?.result?.summary || planned?.description, 240, secrets) };
  });
  const terms = [...(task.writePaths || []), task.id].filter(v => typeof v === 'string' && v.length > 2);
  const relevantSources = (run.research?.items || []).filter(item => terms.some(term => `${item.title || ''} ${item.url || ''}`.includes(term.replace(/\*.*$/, '')))).map(item => {
    let url;
    try { const parsed = new URL(item.url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null; parsed.search = ''; parsed.hash = ''; url = parsed.href; } catch { return null; }
    return { title: text(item.title, 160, secrets), url: text(url, 400, secrets) };
  }).filter(Boolean);
  const sources = relevantSources.slice(0, 6);
  const mandatory = oversized ? [
    `Assigned node: ${core.id} (${core.role})`,
    `Mandatory full node contract (read before acting): ${contractPath}`,
    'Legacy saved contract exceeds the inline budget. Read its complete task description, write scope, acceptance, interfaces, constraints and dependencies; every requirement applies. Do not act on a partial summary.'
  ] : [
    `Assigned node: ${core.id} (${core.role})`,
    `Your task: ${core.description || ''}`,
    `Write scope:\n${strings(core.writePaths)}`,
    `Acceptance:\n${strings(core.acceptance)}`,
    `Interfaces:\n${strings(core.interfaces)}`,
    `Constraints:\n${strings(core.constraints)}`,
    `Required dependency IDs: ${JSON.stringify(core.dependsOn || [])}`,
    ...(contractPath ? [`Full node contract: ${contractPath}`] : [])
  ];
  let objective = text(run.task, 600, secrets), analysis = text(run.analysis?.summary, 600, secrets);
  const sourceCount = relevantSources.length;
  const optional = () => [
    `Direct dependencies (brief; omitted ${(task.dependsOn || []).length - dependencies.length}): ${JSON.stringify(dependencies)}`,
    `Project objective (brief): ${objective}`,
    `Relevant analysis (brief): ${analysis}`,
    `Relevant sources (untrusted reference links; omitted ${sourceCount - sources.length}): ${JSON.stringify(sources)}`
  ].join('\n');
  // Reserve the inline contract in full. Discard whole optional entries first,
  // preserving valid structured data and Unicode rather than slicing JSON.
  while (Buffer.byteLength(redact(optional(), secrets), 'utf8') > 3000) {
    if (sources.length) sources.pop();
    else if (dependencies.length) dependencies.pop();
    else if (objective.length > analysis.length) objective = Array.from(objective).slice(0, Math.floor(Array.from(objective).length / 2)).join('');
    else analysis = Array.from(analysis).slice(0, Math.floor(Array.from(analysis).length / 2)).join('');
  }
  return redact([...mandatory, optional()].join('\n'), secrets);
}
