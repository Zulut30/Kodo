import { toolCatalog } from './tools.mjs';
import { secretFile } from './security.mjs';

export const qualityLanguages = Object.freeze([
  'csharp',
  'rust',
  'go',
  'typescript',
  'javascript',
  'css',
  'html',
  'php',
  'sql',
]);
export const qualityCapabilities = Object.freeze([
  'format',
  'lint',
  'typecheck',
  'test',
  'security',
  'architecture',
  'release',
]);
export const qualitySqlDialects = Object.freeze([
  'ansi',
  'postgres',
  'mysql',
  'sqlite',
  'tsql',
  'snowflake',
  'bigquery',
  'duckdb',
  'redshift',
]);
export const qualityError = (reason, message) => Object.assign(new Error(`Quality: ${message}`), { code: reason });
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exact = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
const nativeTools = ['dotnet', 'cargo', 'rustc', 'clippy', 'rustfmt', 'go', 'php', 'phpcs', 'phpstan', 'phpunit'];
export const managed = new Map(
  toolCatalog
    .filter(t => ['oxlint', 'oxfmt', 'typescript', 'stylelint', 'html-validate', 'sqlfluff'].includes(t.id))
    .map(t => [t.id, t]),
);
export const privateSource = name =>
  secretFile(name) || /(?:^|\/)(?:wp-config\.php|\.npmrc|\.pypirc|composer-auth\.json)$/i.test(name);
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw qualityError('configuration', `invalid ${label} keys`);
}
export function qualityPath(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 2048 ||
    /[\\:\x00-\x1f\x7f*?\[\]{}!]/.test(name) ||
    name.startsWith('/')
  )
    throw qualityError('unsafe_path', 'unsafe relative path');
  const parts = name.split('/');
  if (
    parts.some(
      part =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.startsWith('-') ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    ) ||
    privateSource(name)
  )
    throw qualityError('unsafe_path', 'unsafe or secret path');
  return name;
}
/** @param {Record<string, unknown> & {dialect?: string}} [input] */
// oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export function normalizeQualityConfig(input = {}) {
  keys(
    input,
    [
      'enabled',
      'strictness',
      'mode',
      'tools',
      'dialect',
      'baseline',
      'capabilities',
      'checks',
      'changedPaths',
      'affectedPaths',
      'timeoutMs',
      'maxOutputBytes',
    ],
    'quality',
  );
  const config = {
    enabled: true,
    strictness: 'strict',
    mode: 'quick',
    tools: {},
    baseline: [],
    capabilities: Object.fromEntries(qualityCapabilities.map(c => [c, true])),
    checks: [],
    changedPaths: null,
    affectedPaths: [],
    timeoutMs: 120000,
    maxOutputBytes: 1024 * 1024,
    ...input,
  };
  if (
    typeof config.enabled !== 'boolean' ||
    !['strict', 'standard', 'adopt'].includes(config.strictness) ||
    !['quick', 'standard', 'deep'].includes(config.mode)
  )
    throw qualityError('configuration', 'invalid quality enabled/strictness/mode');
  for (const key of ['timeoutMs', 'maxOutputBytes'])
    if (
      !Number.isInteger(config[key]) ||
      config[key] < 1 ||
      config[key] > (key === 'timeoutMs' ? 1800000 : 16 * 1024 * 1024)
    )
      throw qualityError('configuration', `invalid quality ${key}`);
  keys(config.tools, [...nativeTools, ...managed.keys()], 'quality.tools');
  for (const [id, pin] of Object.entries(config.tools)) {
    keys(pin, ['version', 'path'], `quality.tools.${id}`);
    if (!exact(pin.version)) throw qualityError('configuration', `quality tool ${id} requires an exact version`);
    if (pin.path !== undefined) {
      qualityPath(pin.path);
      if (!['phpcs', 'phpstan', 'phpunit'].includes(id) || !pin.path.startsWith('vendor/'))
        throw qualityError('configuration', 'only project Composer tool paths are configurable');
    }
    if (managed.has(id) && pin.version !== managed.get(id).version)
      throw qualityError('configuration', `quality ${id} pin differs from managed catalog`);
  }
  if (
    config.dialect !== undefined &&
    (typeof config.dialect !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(config.dialect))
  )
    throw qualityError('configuration', 'invalid quality SQL dialect');
  keys(config.capabilities, qualityCapabilities, 'quality.capabilities');
  if (Object.values(config.capabilities).some(v => typeof v !== 'boolean'))
    throw qualityError('configuration', 'quality capabilities require booleans');
  config.capabilities = { ...Object.fromEntries(qualityCapabilities.map(c => [c, true])), ...config.capabilities };
  for (const key of ['changedPaths', 'affectedPaths']) {
    if (key === 'changedPaths' && config[key] === null) continue;
    if (!Array.isArray(config[key]) || config[key].length > 20000)
      throw qualityError('configuration', `invalid quality ${key}`);
    config[key] = [...new Set(config[key].map(qualityPath))].sort();
  }
  if (!Array.isArray(config.baseline) || config.baseline.length > 10000)
    throw qualityError('configuration', 'invalid quality baseline');
  const seen = new Set();
  for (const entry of config.baseline) {
    keys(
      entry,
      ['file', 'line', 'ruleId', 'severity', 'fingerprint', 'sourceHash', 'language', 'capability', 'tool'],
      'quality.baseline',
    );
    qualityPath(entry.file);
    if (
      !qualityLanguages.includes(entry.language) ||
      !qualityCapabilities.includes(entry.capability) ||
      ![...nativeTools, ...managed.keys()].includes(entry.tool) ||
      !Number.isInteger(entry.line) ||
      entry.line < 1 ||
      !['error', 'warning', 'info'].includes(entry.severity) ||
      typeof entry.ruleId !== 'string' ||
      !/^[\w./:()@-]{1,160}$/.test(entry.ruleId) ||
      !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
      !/^[a-f0-9]{64}$/.test(entry.sourceHash)
    )
      throw qualityError('configuration', 'invalid quality baseline observation');
    const identity = JSON.stringify(
      ['language', 'capability', 'tool', 'file', 'line', 'ruleId', 'severity', 'fingerprint', 'sourceHash'].map(
        key => entry[key],
      ),
    );
    if (seen.has(identity)) throw qualityError('configuration', 'duplicate quality baseline');
    seen.add(identity);
  }
  if (!Array.isArray(config.checks) || config.checks.length > 100)
    throw qualityError('configuration', 'invalid quality checks');
  const ids = new Set();
  for (const check of config.checks) {
    keys(
      check,
      [
        'id',
        'language',
        'capability',
        'command',
        'args',
        'version',
        'versionOutput',
        'readOnly',
        'files',
        'scopeReason',
      ],
      'quality.check',
    );
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(check.id ?? '') ||
      ids.has(check.id) ||
      !['test', 'security', 'architecture', 'release'].includes(check.capability) ||
      (check.language !== undefined && !qualityLanguages.includes(check.language)) ||
      check.readOnly !== true ||
      !exact(check.version) ||
      typeof check.versionOutput !== 'string' ||
      !check.versionOutput.includes(check.version) ||
      /[\r\n\x00]/.test(check.versionOutput) ||
      check.versionOutput.length > 200
    )
      throw qualityError('configuration', 'invalid quality configured check');
    ids.add(check.id);
    // Project scripts are explicit trusted checks, not shell snippets. No eval,
    // install, formatter fixes, shipping, or arbitrary environment expansion.
    if (!['node', 'dotnet', 'cargo', 'go', 'php'].includes(check.command))
      throw qualityError('configuration', 'quality configured command must use a known runtime');
    if (
      !Array.isArray(check.args) ||
      !check.args.length ||
      check.args.length > 100 ||
      check.args.some(
        a =>
          typeof a !== 'string' ||
          a.length > 2048 ||
          /[\x00-\x1f]/.test(a) ||
          /^(?:--?(?:fix|write|eval|execute|command|interactive|watch)|-e|-r)(?:=|$)/i.test(a) ||
          /^(?:install|update|publish|push|deploy|release|restore|add|remove)$/i.test(a),
      )
    )
      throw qualityError('configuration', 'unsafe quality configured command arguments');
    if (!Array.isArray(check.files) || !check.files.length)
      throw qualityError('configuration', 'quality configured checks require explicit files');
    check.files.forEach(qualityPath);
    if (
      check.scopeReason !== undefined &&
      (typeof check.scopeReason !== 'string' || !check.scopeReason.trim() || check.scopeReason.length > 300)
    )
      throw qualityError('configuration', 'invalid quality dependency scope reason');
    // Every non-option path argument is checked again against the actual tree
    // before execution. Node/PHP entrypoints must be project-relative files.
    if (['node', 'php'].includes(check.command)) qualityPath(check.args[0].replace(/^\.\//, ''));
  }
  return structuredClone(config);
}
