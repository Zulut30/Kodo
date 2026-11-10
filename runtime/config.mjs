import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeUIConfig } from './ui-verification.mjs';
import { normalizeSecurityConfig } from './security-gates.mjs';
import { normalizeArchitectureConfig } from './architecture-gate.mjs';
import { normalizeMode } from './modes.mjs';
// Read-time provenance only: Engine persists the explicit choice on a new run.
// The default 2 must not become an explicit override of quick's default 1.
export const configuredConcurrency = Symbol('configuredConcurrency');
export function normalizeConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5)
    throw new TypeError('Некорректная конфигурация Kodo: invalid concurrency, expected an integer from 1 to 5');
  return value;
}
export const defaults = {
  schemaVersion: 1,
  repository: null,
  baseBranch: 'main',
  client: 'codex',
  primaryModel: null,
  models: { codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra'], 'claude-code': ['opus', 'sonnet'] },
  concurrency: 2,
  repairRounds: 5,
  researchBudget: 40,
  uiVerification: normalizeUIConfig(),
  security: normalizeSecurityConfig(),
  architecture: normalizeArchitectureConfig(),
  commands: { test: [{ command: 'npm', args: ['test'] }], build: [], deploy: [], smoke: [] },
  checks: ['check (ubuntu-latest, 24)', 'check (windows-latest, 24)'],
  delivery: { enabled: false, release: false, firstVersion: '0.2.0' },
};
export function validateCommandTimeouts(commands) {
  for (const kind of ['test', 'build', 'deploy', 'smoke'])
    for (const [index, command] of (commands[kind] || []).entries()) {
      const timeout = command.timeoutMs;
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 0 || timeout > 2147483647)) {
        throw Object.assign(
          new Error(`Некорректный commands.${kind}[${index}].timeoutMs: требуется целое число от 0 до 2147483647 мс`),
          { code: 'configuration' },
        );
      }
    }
}
export async function readConfig(project, overrides = {}) {
  let file = {};
  try {
    file = JSON.parse(await readFile(path.join(project, 'kodo.config.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = {
    ...defaults,
    ...file,
    ...overrides,
    models: { ...defaults.models, ...file.models },
    commands: { ...defaults.commands, ...file.commands },
    delivery: { ...defaults.delivery, ...file.delivery },
  };
  if (
    overrides.client &&
    overrides.client !== (file.client || defaults.client) &&
    !Object.hasOwn(overrides, 'primaryModel')
  )
    config.primaryModel = file.primaryModels?.[overrides.client] || null;
  normalizeConcurrency(config.concurrency);
  Object.defineProperty(config, configuredConcurrency, {
    value: Object.hasOwn(overrides, 'concurrency') || Object.hasOwn(file, 'concurrency') ? config.concurrency : null,
  });
  if (
    config.schemaVersion !== 1 ||
    !['codex', 'claude-code'].includes(config.client) ||
    !Number.isInteger(config.repairRounds) ||
    config.repairRounds < 1 ||
    config.repairRounds > 5 ||
    !Number.isInteger(config.researchBudget) ||
    config.researchBudget < 0 ||
    config.researchBudget > 40 ||
    !Array.isArray(config.checks)
  )
    throw new Error('Некорректная конфигурация Kodo');
  // Optional: absent means the legacy in-run dispatcher.
  const scheduler = /** @type {any} */ (config).scheduler;
  if (scheduler !== undefined && !['legacy', 'durable'].includes(scheduler))
    throw new Error('Некорректная конфигурация Kodo: scheduler must be "legacy" or "durable"');
  normalizeMode(config.executionMode);
  if (
    config.maxTasks !== undefined &&
    (!Number.isSafeInteger(config.maxTasks) || config.maxTasks < 1 || config.maxTasks > 24)
  )
    throw new Error('Некорректный лимит maxTasks');
  config.uiVerification = normalizeUIConfig(config.uiVerification);
  config.security = normalizeSecurityConfig(config.security);
  config.architecture = normalizeArchitectureConfig(config.architecture);
  for (const kind of ['test', 'build', 'deploy', 'smoke'])
    if (
      !Array.isArray(config.commands[kind]) ||
      config.commands[kind].some(
        item =>
          typeof item.command !== 'string' ||
          !Array.isArray(item.args) ||
          item.args.some(arg => typeof arg !== 'string'),
      )
    )
      throw new Error(`Некорректные команды ${kind}`);
  validateCommandTimeouts(config.commands);
  return config;
}
export async function initConfig(project, overrides = {}) {
  const config = { ...defaults, ...overrides };
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return config;
}
