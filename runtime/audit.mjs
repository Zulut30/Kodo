import { defaultSkillIds } from './skill-policy.mjs';

const stageOrder = ['analyze', 'plan', 'developer', 'tester', 'documenter', 'review', 'repair', 'complete'];
const workerRoles = new Set(['developer', 'tester', 'documenter']);
const skillIds = new Set(defaultSkillIds);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = value => typeof value === 'string' ? value : null;
const lowerHex = (value, length) => typeof value === 'string' && value.length === length && !/[^a-f0-9]/.test(value);

function policyStage(stage, policy) {
  if (!stageOrder.includes(stage)) return { stage, hash: null, valid: false, skills: [], issues: ['Unknown policy stage.'] };
  const issues = new Set();
  if (!isRecord(policy)) issues.add('Policy stage must be an object.');
  const entry = isRecord(policy) ? policy : {};
  if (!lowerHex(entry.hash, 64)) issues.add('Hash must be 64 lowercase hex characters.');
  const decisions = Array.isArray(entry.skills) ? entry.skills : [];
  if (decisions.length !== defaultSkillIds.length) issues.add('Exactly 13 default skill decisions are required.');
  const byId = new Map();
  for (const decision of decisions) {
    if (!isRecord(decision) || !skillIds.has(decision.id)) {
      issues.add('Invalid or unknown skill decision.');
      continue;
    }
    if (byId.has(decision.id)) issues.add('Duplicate skill ID.');
    if (typeof decision.applies !== 'boolean') issues.add('Skill applies must be boolean.');
    if (typeof decision.reason !== 'string' || !decision.reason.trim()) issues.add('Skill reason must be nonempty text.');
    if (!lowerHex(decision.revision, 40)) issues.add('Skill revision must be 40 lowercase hex characters.');
    if (!byId.has(decision.id)) byId.set(decision.id, {
      id: decision.id,
      applies: typeof decision.applies === 'boolean' ? decision.applies : null,
      reason: stringOrNull(decision.reason),
      revision: stringOrNull(decision.revision)
    });
  }
  if (byId.size !== defaultSkillIds.length) issues.add('Missing default skill decisions.');
  return {
    stage, hash: stringOrNull(entry.hash), valid: issues.size === 0,
    skills: defaultSkillIds.filter(id => byId.has(id)).map(id => byId.get(id)),
    ...(issues.size ? { issues: [...issues].sort() } : {})
  };
}

// Copy only typed scalar fields. Never pass through receipt objects, even under
// an allowlisted key: malformed saved data can put arbitrary output there.
function receipt(value, fields) {
  if (!isRecord(value)) return null;
  const result = {};
  for (const [key, type] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (type === 'integer' ? Number.isSafeInteger(field) : typeof field === type) result[key] = field;
  }
  return result;
}

/**
 * Pure, synchronous projection of saved run evidence (schema version 1).
 * Completeness validates recorded instruction metadata, not model compliance,
 * the original prompt bytes, successful checks or a live published artifact.
 * Legacy/malformed nested data remains inspectable; only invalid roots throw.
 */
export function buildAuditReport(run) {
  if (!isRecord(run)) throw new TypeError('Audit requires a saved run object.');
  const tasks = isRecord(run.plan) && Array.isArray(run.plan.tasks) ? run.plan.tasks : [];
  let validPlan = tasks.length > 0;
  const expected = new Set(['analyze', 'plan', 'review', 'complete']);
  for (const task of tasks) {
    if (isRecord(task) && workerRoles.has(task.role)) expected.add(task.role);
    else validPlan = false;
  }
  const policies = isRecord(run.defaultSkills) ? run.defaultSkills : {};
  if (Object.hasOwn(policies, 'repair')) expected.add('repair');
  const expectedStages = stageOrder.filter(stage => expected.has(stage));
  const recordedStages = [
    ...stageOrder.filter(stage => Object.hasOwn(policies, stage)),
    ...Object.keys(policies).filter(stage => !stageOrder.includes(stage)).sort()
  ];
  const missingStages = expectedStages.filter(stage => !Object.hasOwn(policies, stage));
  const stages = recordedStages.map(stage => policyStage(stage, policies[stage]));

  const checks = receipt(run.checks, { headSha: 'string' });
  if (checks && Array.isArray(run.checks.results)) checks.results = run.checks.results.map(result => receipt(result, { exitCode: 'integer' }) ?? {});
  const review = receipt(run.review, { passed: 'boolean', headSha: 'string', diffHash: 'string' });
  const delivery = receipt(run.delivery, { reviewedHead: 'string', mergeCommit: 'string' });
  if (delivery && Object.hasOwn(run.delivery, 'pr')) delivery.pr = receipt(run.delivery.pr, { number: 'integer', url: 'string' });
  const release = receipt(run.release, {
    version: 'string', tag: 'string', commit: 'string', url: 'string', artifact: 'string',
    artifactUrl: 'string', sha256: 'string', published: 'boolean'
  });
  if (release && Object.hasOwn(run.release, 'smoke')) release.smoke = receipt(run.release.smoke, { passed: 'boolean', node: 'string', platform: 'string' });
  return {
    schemaVersion: 1, runId: stringOrNull(run.id), state: stringOrNull(run.state),
    baseSha: stringOrNull(run.baseSha), headSha: stringOrNull(run.headSha), evidenceLevel: 'recorded-instructions',
    skills: { expectedStages, recordedStages, missingStages, complete: validPlan && missingStages.length === 0 && stages.every(stage => stage.valid), stages },
    checks, review, delivery, release
  };
}

export function formatAuditReport(report) {
  const { skills } = report;
  const invalidStages = skills.stages.filter(stage => !stage.valid).map(stage => stage.stage);
  const lines = [
    `Запуск: ${report.runId ?? 'не указан'} | Состояние: ${report.state ?? 'не указано'}`,
    `Доказательства: ${report.evidenceLevel}; семантическое соблюдение инструкций моделью не доказано.`,
    `Покрытие навыков: ${skills.complete ? 'полное (complete)' : 'неполное (incomplete)'}`,
    `Ожидаемые этапы: ${skills.expectedStages.join(', ')}`,
    `Отсутствующие этапы: ${skills.missingStages.join(', ') || 'нет'}`,
    `Некорректные этапы: ${invalidStages.join(', ') || 'нет'}`
  ];
  if (!skills.complete && !skills.missingStages.length && !invalidStages.length) lines.push('Не подтверждён корректный непустой plan.tasks.');
  for (const entry of skills.stages) {
    const applied = entry.skills.filter(skill => skill.applies === true);
    lines.push(`${entry.stage}: ${entry.valid ? 'valid' : 'invalid'}, применено ${applied.length}/${defaultSkillIds.length}; hash: ${entry.hash ?? 'нет'}`);
    lines.push(`  Применимые навыки: ${applied.map(skill => skill.id).join(', ') || 'нет'}`);
    if (entry.issues) lines.push(`  ${entry.issues.join(' ')}`);
  }
  if (report.checks) lines.push(`Проверки: ${(report.checks.results ?? []).map(result => result.exitCode ?? 'неизвестно').join(', ') || 'нет результатов'} (exitCode)`);
  if (report.review) lines.push(`Ревью: ${report.review.passed === true ? 'passed' : report.review.passed === false ? 'failed' : 'неизвестно'}`);
  if (report.delivery?.pr) lines.push(`PR: ${report.delivery.pr.number ?? 'неизвестно'} ${report.delivery.pr.url ?? ''}`);
  if (report.release) lines.push(`Релиз: ${report.release.tag ?? report.release.version ?? 'неизвестно'} ${report.release.url ?? ''} (published: ${report.release.published ?? 'неизвестно'})`);
  return lines.join('\n');
}
