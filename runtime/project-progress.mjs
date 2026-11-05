const statuses = ['proposed', 'ready', 'reserved', 'running', 'verifying', 'integrated', 'accepted', 'released', 'blocked', 'failed', 'cancelled'];
const integer = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown';

// Counts and fixed vocabulary only: no title, ID, root, prompt, error message,
// mapping reason, credential or evidence path can cross this output boundary.
export function buildProjectProgress(snapshot) {
  const project = snapshot?.project;
  const status = statuses.includes(project?.status) ? project.status : 'unknown';
  const lines = ['# Kodo project progress', 'SQLite is authoritative; this bounded summary is not acceptance or publication proof.',
    `Revision: ${integer(snapshot?.revision)}; project: ${status}; control: ${project?.paused === true ? 'blocked (paused)' : project?.paused === false ? 'active' : 'unknown'}`];
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const rows = Array.isArray(snapshot?.[key]) ? snapshot[key] : null;
    const count = snapshot?.completeness?.[key];
    const coherent = rows && Number.isSafeInteger(count?.total) && count.total >= rows.length && count.returned === rows.length;
    const complete = coherent && count.complete === true && count.total === rows.length;
    lines.push(`${key}: returned ${integer(rows?.length)} / total ${integer(coherent ? count.total : undefined)}; completeness: ${complete ? 'complete' : 'unknown (blocked)'}`);
    if (key === 'riskApprovals' || !rows) continue;
    const counts = new Map(statuses.map(state => [state, 0])); let unknown = 0;
    for (const row of rows) { if (counts.has(row?.status)) counts.set(row.status, counts.get(row.status) + 1); else unknown++; }
    lines.push(`  ${[...counts].filter(([, total]) => total).map(([state, total]) => `${state} ${total}`).join('; ') || 'none'}; unknown ${unknown}`);
  }
  lines.push('Evidence: unknown until trusted validation; disabled gates: neutral; blocked or incomplete sets cannot establish acceptance.');
  return lines.join('\n') + '\n';
}
