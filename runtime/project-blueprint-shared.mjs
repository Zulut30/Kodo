// Shared constants and helpers of the project factory blueprint
// (`project-blueprint.mjs`): limits, roles, required sections, findings and
// bounded-read failures used by reading, linting and compiling.

export const BLUEPRINT_DIR = '.kodo/blueprint';
export const MAX_MILESTONE_TASKS = 80;
export const MAX_PROJECT_TASKS = 400;
export const MAX_TASK_INPUT_BYTES = 12000;
export const MAX_TASK_WRITE_PATHS = 24;
export const MAX_TASK_MODULES = 3;
export const FOUNDATION_ID = 'foundation';
export const FACTORY_ROLES = Object.freeze([
  'architect',
  'developer',
  'integrator',
  'ui-qa',
  'performance',
  'security',
  'reviewer',
]);
export const DEFAULT_EXECUTION = Object.freeze({ cadence: 'wave', integration: 'branch' });
export const REQUIRED_SECTIONS = Object.freeze([
  { title: 'Цель', aliases: ['цель', 'цели', 'goal', 'goals'] },
  { title: 'Модули', aliases: ['модули', 'карта модулей', 'modules', 'module map'] },
  { title: 'Стек', aliases: ['стек', 'технологический стек', 'stack', 'tech stack', 'technology stack'] },
  { title: 'Критерии готовности', aliases: ['критерии готовности', 'definition of done', 'acceptance criteria'] },
]);
export const BLUEPRINT_LIMITS = Object.freeze({
  project: 64 * 1024,
  spec: 16 * 1024 * 1024,
  interface: 64 * 1024,
  interfaces: 64,
  interfacesTotal: 1024 * 1024,
});
export const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const isPlain = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const slashed = value => value.replaceAll('\\', '/').replace(/\/+$/, '');
export const windowsLike = value => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
export const shown = value => JSON.stringify(String(value).slice(0, 80));
export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
/** A finding never interpolates file contents; only ids, names and counts. */
export function finding(code, message, taskIds) {
  return taskIds ? { code, taskIds, message } : { code, message };
}
