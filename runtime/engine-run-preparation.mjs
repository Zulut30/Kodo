import path from 'node:path';
import { redact } from './security.mjs';
import { readConfig, configuredConcurrency } from './config.mjs';
import { validatePlan } from './contracts.mjs';
import { git, inspectProject } from './workspace.mjs';
import { loadDefaultPolicy } from './skill-policy.mjs';
import { validateTaskContract } from './task-context.mjs';
import { normalizeMode } from './modes.mjs';

export function validateModePlan(run, candidate, { legacy = false } = {}) {
  validatePlan(candidate);
  if (candidate.tasks.length > run.executionMode.profile.maxTasks)
    throw Object.assign(
      new Error(`План превышает maxTasks=${run.executionMode.profile.maxTasks} для ${run.executionMode.selected}`),
      { code: 'invalid_plan' },
    );
  if (!legacy) candidate.tasks.forEach(validateTaskContract);
  return candidate;
}
export async function policy(engine, run, stage) {
  const policy = await loadDefaultPolicy({ project: run.cwd, stage, task: run.task, run });
  run.defaultSkills ||= {};
  run.defaultSkills[stage] = { hash: policy.hash, skills: policy.skills };
  engine.save(run);
  return `Kodo default engineering skills (user-selected; follow within the authorized task and coordinator-owned worktree/model/delivery rules):\n${policy.context}\n`;
}
export async function prepareRun(engine, task, options = {}, reserved = false) {
  if (!task?.trim()) throw new Error('Требуется описание задачи');
  const project = path.resolve(options.project || process.cwd());
  normalizeMode(options.mode);
  const config = await readConfig(project, {
    ...(options.client ? { client: options.client } : {}),
    ...(options.model ? { primaryModel: options.model } : {}),
    ...(options.mode !== undefined ? { executionMode: options.mode } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
  });
  if (options.model && !config.models[config.client]?.includes(options.model))
    throw new Error('Выбранная модель отсутствует в allowlist проекта');
  const snapshot = await inspectProject(project);
  const mode =
    options.providers ||
    (!reserved && /использ\S*\s+обе\s+подпис|use both subscriptions/i.test(task) ? 'both' : 'current');
  if (!['current', 'both'].includes(mode)) throw new Error('providers должен быть current или both');
  if (!['none', 'pr', 'release'].includes(options.delivery || 'none')) throw new Error('Некорректный режим доставки');
  if (options.delivery)
    config.delivery = {
      ...config.delivery,
      enabled: options.delivery !== 'none',
      release: options.delivery === 'release',
    };
  if (config.delivery.enabled && !config.repository)
    throw new Error('Для доставки укажи repository в kodo.config.json');
  let baseSha = snapshot.head;
  if (config.delivery.enabled) {
    await git(snapshot.root, ['fetch', 'origin', config.baseBranch]);
    baseSha = await git(snapshot.root, ['rev-parse', `origin/${config.baseBranch}`]);
  }
  if (reserved && options.baseSha !== undefined) {
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.baseSha) ||
      (await git(snapshot.root, ['rev-parse', '--verify', `${options.baseSha}^{commit}`])) !== options.baseSha
    )
      throw Object.assign(new Error('Invalid project integration frontier'), { code: 'project_frontier_blocked' });
    baseSha = options.baseSha;
  }
  return {
    task: redact(task, engine.secrets),
    project: snapshot.root,
    config: reserved ? { ...config } : config,
    client: config.client,
    providers: mode,
    baseSha,
    snapshot,
    completed: {},
    nodes: {},
    requestedMode: config.executionMode ?? null,
    requestedConcurrency: config[configuredConcurrency],
    ...(options.model ? { fixedModel: { client: config.client, model: options.model } } : {}),
    sessionAttempts: [],
    coordinatorOperations: [],
  };
}
