import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redact, stateHome } from './security.mjs';

const short = (value, max = 240) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value)
        .replace(/[\r\n\0]/g, ' ')
        .slice(0, max)
    : '';
export function buildProgress(run) {
  const nodes = Object.entries(run.nodes || {});
  const lines = [
    '# Kodo progress',
    'SQLite is authoritative. This bounded recovery summary is rebuilt from saved state.',
    `Run: ${short(run.id)}`,
    `Stage: ${short(run.state)}`,
    `Base commit: ${short(run.baseSha, 64)}`,
    `Checked commit: ${short(run.headSha, 64)}`,
    `Nodes: ${nodes.length}; integrated: ${nodes.filter(([, n]) => n.status === 'integrated').length}`,
    '',
  ];
  for (const [id, node] of nodes.slice(0, 30))
    lines.push(
      `- ${short(id, 100)}: ${short(node.status, 40)}; attempt ${short(node.attempt, 4)}; commit ${short(node.headSha, 64)}${node.error ? `; blocker ${short(node.error, 120)}` : ''}`,
    );
  if (nodes.length > 30) lines.push('Additional nodes are recorded in SQLite.');
  lines.push('', `Checks commit: ${short(run.checks?.headSha, 64)}`);
  for (const check of (run.checks?.results || []).slice(0, 30))
    lines.push(`- ${short(check.kind, 20)}: exit ${short(check.exitCode, 8)}`);
  for (const [label, receipt] of [
    ['UI', run.uiVerification],
    ['Security', run.securityChecks],
  ])
    lines.push(`${label}: ${short(receipt?.status || 'pending', 40)}; commit ${short(receipt?.headSha, 64)}`);
  lines.push(
    `Review: ${run.review ? (run.review.passed === true ? 'passed' : 'failed') : 'pending'}; commit ${short(run.review?.headSha, 64)}`,
    `Delivery: ${run.delivery?.mergeCommit ? `merged ${short(run.delivery.mergeCommit, 64)}` : run.delivery?.pr ? `PR ${short(run.delivery.pr.number, 20)}` : 'pending'}`,
    `Release: ${run.release?.published === true ? 'published' : 'pending'} ${short(run.release?.version, 40)}`,
  );
  if (run.controllerAssessment)
    lines.push(
      `Controller: ${short(run.controllerAssessment.reason, 100)}; ${short(run.controllerAssessment.summary, 600)}`,
    );
  if (run.error) lines.push(`Pending blocker: ${short(run.error.code, 60)} ${short(run.error.message, 600)}`);
  // UTF-8 can use four bytes per JS character; this bound stays below 64 KiB.
  return redact(lines.join('\n').slice(0, 16000)) + '\n';
}
export function assertPrivateArtifactPath(filename) {
  for (let current = filename; ; current = path.dirname(current)) {
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Progress path contains a symbolic link');
      if (existsSync(path.join(current, '.git')))
        throw Object.assign(new Error('Progress must remain outside a Git repository'), { code: 'artifacts_in_git' });
    }
    if (path.dirname(current) === current) break;
  }
}
export function writeProgress(run, { home = stateHome(), secrets = {} } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(run.id || '')) throw new Error('Invalid progress run identifier');
  const directory = path.resolve(home, 'runs', run.id);
  if (run.artifacts && path.resolve(run.artifacts) !== directory)
    throw new Error('Progress artifacts differ from the run state directory');
  assertPrivateArtifactPath(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'progress.md'),
    temporary = path.join(directory, `.progress-${randomUUID()}.tmp`);
  assertPrivateArtifactPath(filename);
  try {
    writeFileSync(temporary, redact(buildProgress(run), secrets), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, filename);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return filename;
}
