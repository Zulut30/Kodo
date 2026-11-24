const statuses = [
  'proposed',
  'ready',
  'reserved',
  'running',
  'verifying',
  'integrated',
  'accepted',
  'released',
  'blocked',
  'failed',
  'cancelled',
];
const integer = value => (Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown');

// Counts and fixed vocabulary only: no title, ID, root, prompt, error message,
// mapping reason, credential or evidence path can cross this output boundary.
// `blockers` (optional): rows of `kodo report --project`; only their codes are counted here.
export function buildProjectProgress(snapshot, blockers) {
  const project = snapshot?.project;
  const status = statuses.includes(project?.status) ? project.status : 'unknown';
  const lines = [
    '# Kodo project progress',
    'SQLite is authoritative; this bounded summary is not acceptance or publication proof.',
    `Revision: ${integer(snapshot?.revision)}; project: ${status}; control: ${project?.paused === true ? 'blocked (paused)' : project?.paused === false ? 'active' : 'unknown'}`,
  ];
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals']) {
    const rows = Array.isArray(snapshot?.[key]) ? snapshot[key] : null;
    const count = snapshot?.completeness?.[key];
    const coherent =
      rows && Number.isSafeInteger(count?.total) && count.total >= rows.length && count.returned === rows.length;
    const complete = coherent && count.complete === true && count.total === rows.length;
    lines.push(
      `${key}: returned ${integer(rows?.length)} / total ${integer(coherent ? count.total : undefined)}; completeness: ${complete ? 'complete' : 'unknown (blocked)'}`,
    );
    if (key === 'riskApprovals' || !rows) continue;
    const counts = new Map(statuses.map(state => [state, 0]));
    let unknown = 0;
    for (const row of rows) {
      if (counts.has(row?.status)) counts.set(row.status, counts.get(row.status) + 1);
      else unknown++;
    }
    lines.push(
      `  ${
        [...counts]
          .filter(([, total]) => total)
          .map(([state, total]) => `${state} ${total}`)
          .join('; ') || 'none'
      }; unknown ${unknown}`,
    );
  }
  // Wave projects only: legacy snapshots have no gates key and no gates line.
  if (snapshot && Object.hasOwn(snapshot, 'gates')) lines.push(...gateLines(snapshot));
  if (Array.isArray(blockers)) lines.push(blockerLine(blockers));
  lines.push(
    'Evidence: unknown until trusted validation; disabled gates: neutral; blocked or incomplete sets cannot establish acceptance.',
  );
  return lines.join('\n') + '\n';
}

// Codes only (task, attempt, gate or project blockers), never their task or Run ids.
function blockerLine(blockers) {
  const counts = new Map();
  for (const row of blockers) {
    const code = typeof row?.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(row.code) ? row.code : 'unknown';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const listed = [...counts].map(([code, total]) => `${code} ${total}`).join('; ');
  return `blockers: ${blockers.length}${listed ? `; ${listed}` : ''}`;
}

function gateLines(snapshot) {
  const rows = Array.isArray(snapshot.gates) ? snapshot.gates : null;
  const count = snapshot.completeness?.gates;
  const coherent =
    rows && Number.isSafeInteger(count?.total) && count.total >= rows.length && count.returned === rows.length;
  const complete = coherent && count.complete === true && count.total === rows.length;
  const installed = rows ? rows.filter(row => row?.installed === true).length : undefined;
  return [
    `gates: returned ${integer(rows?.length)} / total ${integer(coherent ? count.total : undefined)}; completeness: ${complete ? 'complete' : 'unknown (blocked)'}`,
    `  installed ${integer(installed)}; reserved ${integer(rows ? rows.length - installed : undefined)}`,
  ];
}
