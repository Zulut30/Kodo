import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUIConfig } from './ui-verification.mjs';
import { normalizeSecurityConfig } from './security-gates.mjs';
export const defaults = {
  schemaVersion: 1, repository: null, baseBranch: 'main', client: 'codex', primaryModel: null,
  models: { codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra'], 'claude-code': ['opus', 'sonnet'] },
  concurrency: 2, repairRounds: 5, researchBudget: 40,
  uiVerification: normalizeUIConfig(), security: normalizeSecurityConfig(),
  commands: { test: [{ command: 'npm', args: ['test'] }], build: [], deploy: [], smoke: [] },
  checks: ['check (ubuntu-latest, 24)', 'check (windows-latest, 24)'],
  delivery: { enabled: false, release: false, firstVersion: '0.2.0' }
};
export async function readConfig(project, overrides = {}) {
  let file = {};
  try { file = JSON.parse(await readFile(path.join(project, 'kodo.config.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = { ...defaults, ...file, ...overrides, models: { ...defaults.models, ...file.models }, commands: { ...defaults.commands, ...file.commands }, delivery: { ...defaults.delivery, ...file.delivery } };
  if (overrides.client && overrides.client !== (file.client || defaults.client) && !Object.hasOwn(overrides, 'primaryModel')) config.primaryModel = file.primaryModels?.[overrides.client] || null;
  if (config.schemaVersion !== 1 || !['codex', 'claude-code'].includes(config.client) || !Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 2 || !Number.isInteger(config.repairRounds) || config.repairRounds < 1 || config.repairRounds > 5 || !Number.isInteger(config.researchBudget) || config.researchBudget < 0 || config.researchBudget > 40 || !Array.isArray(config.checks)) throw new Error('Некорректная конфигурация Kodo');
  config.uiVerification = normalizeUIConfig(config.uiVerification); config.security = normalizeSecurityConfig(config.security);
  for (const kind of ['test', 'build', 'deploy', 'smoke']) if (!Array.isArray(config.commands[kind]) || config.commands[kind].some(item => typeof item.command !== 'string' || !Array.isArray(item.args) || item.args.some(arg => typeof arg !== 'string'))) throw new Error(`Некорректные команды ${kind}`);
  return config;
}
export async function initConfig(project, overrides = {}) {
  const config = { ...defaults, ...overrides };
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' }); return config;
}
