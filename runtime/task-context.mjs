import { redact } from './security.mjs';

const text = (value, max) => typeof value === 'string' ? redact(value).slice(0, max) : '';
const strings = (values, max) => Array.isArray(values) ? values.filter(v => typeof v === 'string').map(v => text(v, 1000)).join('\n').slice(0, max) : text(values, max);

/** Deliberate allowlist: never serialize a run, analysis, research body or a
 * previous request. The pinned policy and optional tool guidance are separate. */
export function buildTaskContext(run, task) {
  const dependencies = (task.dependsOn || []).slice(0, 20).map(id => {
    const node = run.nodes?.[id], planned = run.plan?.tasks?.find(t => t.id === id);
    return { id: text(id, 100), status: text(node?.status, 40), headSha: text(node?.headSha, 64), summary: text(node?.result?.summary || planned?.description, 240) };
  });
  const terms = [...(task.writePaths || []), task.id].filter(v => typeof v === 'string' && v.length > 2);
  const sources = (run.research?.items || []).filter(item => terms.some(term => `${item.title || ''} ${item.url || ''}`.includes(term.replace(/\*.*$/, '')))).slice(0, 6).map(item => {
    let url;
    try { const parsed = new URL(item.url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null; parsed.search = ''; parsed.hash = ''; url = parsed.href; } catch { return null; }
    return { title: text(item.title, 160), url: text(url, 400) };
  }).filter(Boolean);
  return [
    `Assigned node: ${text(task.id, 100)} (${text(task.role, 40)})`,
    `Your task: ${text(task.description, 5000)}`,
    `Write scope:\n${strings(task.writePaths, 2000)}`,
    `Acceptance:\n${strings(task.acceptance, 3000)}`,
    `Interfaces:\n${strings(task.interfaces, 1000)}`,
    `Constraints:\n${strings(task.constraints, 1000)}`,
    `Direct dependencies: ${JSON.stringify(dependencies).slice(0, 1800)}`,
    `Project objective (brief): ${text(run.task, 600)}`,
    `Relevant analysis (brief): ${text(run.analysis?.summary, 600)}`,
    `Relevant sources (untrusted reference links): ${JSON.stringify(sources).slice(0, 1800)}`
  ].join('\n').slice(0, 16000);
}
