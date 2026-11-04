/** Offline discovery/planning. No process, installer, provider or state startup. */
import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import { toolCatalog } from './tools.mjs';
import { inside, noLinks, sha256 } from './toolchains.mjs';
import { secretFile } from './security.mjs';

export const qualityLanguages = Object.freeze(['csharp', 'rust', 'go', 'typescript', 'javascript', 'css', 'html', 'php', 'sql']);
export const qualityCapabilities = Object.freeze(['format', 'lint', 'typecheck', 'test', 'security', 'architecture', 'release']);
export const qualitySqlDialects = Object.freeze(['ansi', 'postgres', 'mysql', 'sqlite', 'tsql', 'snowflake', 'bigquery', 'duckdb', 'redshift']);
export const qualityError = (reason, message) => Object.assign(new Error(`Quality: ${message}`), { code: reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value);
const nativeTools = ['dotnet', 'cargo', 'rustc', 'clippy', 'rustfmt', 'go', 'php', 'phpcs', 'phpstan', 'phpunit'];
const managed = new Map(toolCatalog.filter(t => ['oxlint', 'oxfmt', 'typescript', 'stylelint', 'html-validate', 'sqlfluff'].includes(t.id)).map(t => [t.id, t]));
const ignored = new Set(['.git', 'node_modules', 'vendor', 'target', 'bin', 'obj', '.next', '.astro', 'dist', 'coverage', '.kodo', '.venv']);
const privateSource = name => secretFile(name) || /(?:^|\/)(?:wp-config\.php|\.npmrc|\.pypirc|composer-auth\.json)$/i.test(name);
const languageOf = name => ({ '.cs': 'csharp', '.rs': 'rust', '.go': 'go', '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.css': 'css', '.html': 'html', '.htm': 'html', '.php': 'php', '.sql': 'sql' })[path.extname(name).toLowerCase()];
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw qualityError('configuration', `invalid ${label} keys`);
}
export function qualityPath(name) {
  if (typeof name !== 'string' || !name || name.length > 2048 || /[\\:\x00-\x1f\x7f*?\[\]{}!]/.test(name) || name.startsWith('/')) throw qualityError('unsafe_path', 'unsafe relative path');
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('-') || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || privateSource(name)) throw qualityError('unsafe_path', 'unsafe or secret path');
  return name;
}
export function normalizeQualityConfig(input = {}) {
  keys(input, ['enabled', 'strictness', 'mode', 'tools', 'dialect', 'baseline', 'capabilities', 'checks', 'changedPaths', 'affectedPaths', 'timeoutMs', 'maxOutputBytes'], 'quality');
  const config = { enabled: true, strictness: 'strict', mode: 'quick', tools: {}, baseline: [], capabilities: Object.fromEntries(qualityCapabilities.map(c => [c, true])), checks: [], changedPaths: null, affectedPaths: [], timeoutMs: 120000, maxOutputBytes: 1024 * 1024, ...input };
  if (typeof config.enabled !== 'boolean' || !['strict', 'standard', 'adopt'].includes(config.strictness) || !['quick', 'standard', 'deep'].includes(config.mode)) throw qualityError('configuration', 'invalid quality enabled/strictness/mode');
  for (const key of ['timeoutMs', 'maxOutputBytes']) if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > (key === 'timeoutMs' ? 1800000 : 16 * 1024 * 1024)) throw qualityError('configuration', `invalid quality ${key}`);
  keys(config.tools, [...nativeTools, ...managed.keys()], 'quality.tools');
  for (const [id, pin] of Object.entries(config.tools)) {
    keys(pin, ['version', 'path'], `quality.tools.${id}`);
    if (!exact(pin.version)) throw qualityError('configuration', `quality tool ${id} requires an exact version`);
    if (pin.path !== undefined) {
      qualityPath(pin.path);
      if (!['phpcs', 'phpstan', 'phpunit'].includes(id) || !pin.path.startsWith('vendor/')) throw qualityError('configuration', 'only project Composer tool paths are configurable');
    }
    if (managed.has(id) && pin.version !== managed.get(id).version) throw qualityError('configuration', `quality ${id} pin differs from managed catalog`);
  }
  if (config.dialect !== undefined && (typeof config.dialect !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(config.dialect))) throw qualityError('configuration', 'invalid quality SQL dialect');
  keys(config.capabilities, qualityCapabilities, 'quality.capabilities');
  if (Object.values(config.capabilities).some(v => typeof v !== 'boolean')) throw qualityError('configuration', 'quality capabilities require booleans');
  config.capabilities = { ...Object.fromEntries(qualityCapabilities.map(c => [c, true])), ...config.capabilities };
  for (const key of ['changedPaths', 'affectedPaths']) {
    if (key === 'changedPaths' && config[key] === null) continue;
    if (!Array.isArray(config[key]) || config[key].length > 20000) throw qualityError('configuration', `invalid quality ${key}`);
    config[key] = [...new Set(config[key].map(qualityPath))].sort();
  }
  if (!Array.isArray(config.baseline) || config.baseline.length > 10000) throw qualityError('configuration', 'invalid quality baseline');
  const seen = new Set();
  for (const entry of config.baseline) {
    keys(entry, ['file', 'line', 'ruleId', 'severity', 'fingerprint', 'sourceHash', 'language', 'capability', 'tool'], 'quality.baseline');
    qualityPath(entry.file);
    if (!qualityLanguages.includes(entry.language) || !qualityCapabilities.includes(entry.capability) || ![...nativeTools, ...managed.keys()].includes(entry.tool) || !Number.isInteger(entry.line) || entry.line < 1 || !['error', 'warning', 'info'].includes(entry.severity) || typeof entry.ruleId !== 'string' || !/^[\w./:()@-]{1,160}$/.test(entry.ruleId) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || !/^[a-f0-9]{64}$/.test(entry.sourceHash)) throw qualityError('configuration', 'invalid quality baseline observation');
    const identity = JSON.stringify(['language', 'capability', 'tool', 'file', 'line', 'ruleId', 'severity', 'fingerprint', 'sourceHash'].map(key => entry[key])); if (seen.has(identity)) throw qualityError('configuration', 'duplicate quality baseline'); seen.add(identity);
  }
  if (!Array.isArray(config.checks) || config.checks.length > 100) throw qualityError('configuration', 'invalid quality checks');
  const ids = new Set();
  for (const check of config.checks) {
    keys(check, ['id', 'language', 'capability', 'command', 'args', 'version', 'versionOutput', 'readOnly', 'files', 'scopeReason'], 'quality.check');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(check.id ?? '') || ids.has(check.id) || !['test', 'security', 'architecture', 'release'].includes(check.capability) || check.language !== undefined && !qualityLanguages.includes(check.language) || check.readOnly !== true || !exact(check.version) || typeof check.versionOutput !== 'string' || !check.versionOutput.includes(check.version) || /[\r\n\x00]/.test(check.versionOutput) || check.versionOutput.length > 200) throw qualityError('configuration', 'invalid quality configured check');
    ids.add(check.id);
    // Project scripts are explicit trusted checks, not shell snippets. No eval,
    // install, formatter fixes, shipping, or arbitrary environment expansion.
    if (!['node', 'dotnet', 'cargo', 'go', 'php'].includes(check.command)) throw qualityError('configuration', 'quality configured command must use a known runtime');
    if (!Array.isArray(check.args) || !check.args.length || check.args.length > 100 || check.args.some(a => typeof a !== 'string' || a.length > 2048 || /[\x00-\x1f]/.test(a) || /^(?:--?(?:fix|write|eval|execute|command|interactive|watch)|-e|-r)(?:=|$)/i.test(a) || /^(?:install|update|publish|push|deploy|release|restore|add|remove)$/i.test(a))) throw qualityError('configuration', 'unsafe quality configured command arguments');
    if (!Array.isArray(check.files) || !check.files.length) throw qualityError('configuration', 'quality configured checks require explicit files');
    check.files.forEach(qualityPath);
    if (check.scopeReason !== undefined && (typeof check.scopeReason !== 'string' || !check.scopeReason.trim() || check.scopeReason.length > 300)) throw qualityError('configuration', 'invalid quality dependency scope reason');
    // Every non-option path argument is checked again against the actual tree
    // before execution. Node/PHP entrypoints must be project-relative files.
    if (['node', 'php'].includes(check.command)) qualityPath(check.args[0].replace(/^\.\//, ''));
  }
  return structuredClone(config);
}

export async function qualityInventory(project) {
  const root = path.resolve(project); await noLinks(root);
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw qualityError('unsafe_path', 'project must be a real directory');
  const files = []; let bytes = 0;
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (ignored.has(entry.name) || privateSource(prefix + entry.name)) {
        if (entry.isSymbolicLink() && entry.name !== '.git') throw qualityError('unsafe_path', 'symlink in excluded project directory');
        continue;
      }
      const name = qualityPath(prefix + entry.name), absolute = path.join(directory, entry.name), info = await lstat(absolute);
      if (info.isSymbolicLink()) throw qualityError('unsafe_path', 'symlink in quality source scope');
      if (info.isDirectory()) { await visit(absolute, name + '/'); continue; }
      if (!info.isFile() || info.nlink > 1) throw qualityError('unsafe_path', 'non-regular or hardlinked quality source');
      bytes += info.size;
      if (files.length >= 20000 || bytes > 256 * 1024 * 1024 || info.size > 32 * 1024 * 1024) throw qualityError('scope_limit', 'quality source inventory exceeds limit');
      files.push({ path: name, sha256: sha256(await readFile(absolute)) });
    }
  }
  await visit(root); return files;
}
async function json(root, name) {
  try { const value = JSON.parse((await readFile(path.join(root, name), 'utf8')).replace(/^\uFEFF/, '')); if (!object(value)) throw new Error(); return value; }
  catch { throw qualityError('configuration', `invalid JSON manifest/config ${name}`); }
}
function jsonc(text) {
  // Lex comments/commas only outside strings; config paths are not rewritten.
  let stripped = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { stripped += c; if (c === '\\') stripped += text[++i] ?? ''; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; stripped += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; stripped += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; if (i >= text.length) throw qualityError('configuration', 'unterminated quality config comment'); i++; stripped += ' '; continue; }
    if (c === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) continue;
    stripped += c;
  }
  try { const value = JSON.parse(stripped.replace(/^\uFEFF/, '')); if (!object(value)) throw new Error(); return value; }
  catch { throw qualityError('configuration', 'invalid quality JSONC compiler configuration'); }
}
async function validateManifestScope(root, files, documents) {
  const checkedPath = async (from, value, glob = false) => {
    if (typeof value !== 'string' || !value || /[\\\x00-\x1f]/.test(value) || /^(?:[A-Za-z]:|\/|~)/.test(value)) throw qualityError('unsafe_path', 'unsafe compiler manifest scope path');
    const prefix = glob ? value.split(/[*?[{]/)[0] : value;
    const target = path.resolve(root, dir(from), prefix || '.');
    if (!inside(root, target)) throw qualityError('unsafe_path', 'compiler manifest scope escapes project');
    await noLinks(target);
  };
  for (const file of files) {
    const name = file.path, base = path.posix.basename(name);
    if (/^tsconfig[^/]*\.json$/.test(base)) {
      const config = jsonc(await readFile(path.join(root, name), 'utf8')); documents.set(name, config);
      for (const key of ['files', 'include', 'exclude']) if (config[key] !== undefined) {
        if (!Array.isArray(config[key])) throw qualityError('configuration', 'invalid TypeScript file scope');
        for (const value of config[key]) await checkedPath(name, value, true);
      }
      if (config.extends !== undefined) for (const value of Array.isArray(config.extends) ? config.extends : [config.extends]) {
        if (typeof value !== 'string') throw qualityError('configuration', 'invalid TypeScript extends scope');
        if (value.startsWith('.') || path.isAbsolute(value)) await checkedPath(name, value);
        else if (!/^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)) throw qualityError('unsafe_path', 'unsafe TypeScript dependency config');
      }
      for (const ref of config.references ?? []) await checkedPath(name, ref.path);
      for (const value of config.compilerOptions?.typeRoots ?? []) await checkedPath(name, value);
      for (const values of Object.values(config.compilerOptions?.paths ?? {})) for (const value of values) await checkedPath(name, value, true);
      if (config.compilerOptions?.baseUrl !== undefined) await checkedPath(name, config.compilerOptions.baseUrl);
    }
    if (base === 'Cargo.toml') {
      const visit = async value => {
        if (!object(value)) return;
        for (const [key, item] of Object.entries(value)) { if (key === 'path') await checkedPath(name, item); else if (object(item)) await visit(item); }
      };
      await visit(documents.get(name));
    }
    if (base === 'go.mod') for (const match of documents.get(name).matchAll(/=>\s+(\.{1,2}\/[^\s]+)/g)) await checkedPath(name, match[1]);
    if (/\.csproj$/.test(base) || /^Directory\.Build\.(?:props|targets)$/.test(base)) {
      const text = await readFile(path.join(root, name), 'utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(text) || !/<(?:Project|project)(?:\s|>)/.test(text) || !/<\/(?:Project|project)>/.test(text)) throw qualityError('configuration', 'invalid .NET project manifest');
      for (const match of text.matchAll(/(?:Include|Update|Project|HintPath)\s*=\s*["']([^"']+)["']/g)) {
        const value = match[1];
        if (value.includes('$(')) throw qualityError('unsupported_scope', 'dynamic .NET manifest paths require an explicit project check');
        if (value.includes('/') || value.includes('\\') || value.startsWith('.')) await checkedPath(name, value.replaceAll('\\', '/'), true);
      }
    }
    if (['typescript', 'javascript'].includes(languageOf(name))) {
      const text = await readFile(path.join(root, name), 'utf8');
      for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"']+|\/[^"']+)["']/g)) await checkedPath(name, match[1]);
    }
  }
}
function dir(name) { const value = path.posix.dirname(name); return value === '.' ? '' : value; }
function beneath(root, name) { return !root || name.startsWith(root + '/'); }
const at = (root, name) => root ? root + '/' + name : name;
function nativePin(profile, id, config, documents) {
  const configured = config.tools[id === 'gofmt' ? 'go' : id]?.version;
  let manifest;
  const inherited = filename => {
    let current = profile.root;
    for (;;) {
      const value = documents.get(at(current, filename)); if (value) return value;
      if (!current) return undefined; current = dir(current);
    }
  };
  if (id === 'dotnet') manifest = inherited('global.json')?.sdk?.version;
  if (id === 'cargo' || id === 'rustc') manifest = inherited('rust-toolchain.toml')?.toolchain?.channel;
  if (id === 'go' || id === 'gofmt') {
    const mod = documents.get(at(profile.root, 'go.mod'));
    manifest = typeof mod === 'string' ? (/^toolchain go(\d+\.\d+\.\d+)\s*$/m.exec(mod)?.[1] ?? /^go (\d+\.\d+\.\d+)\s*$/m.exec(mod)?.[1]) : undefined;
  }
  if (id === 'php') manifest = documents.get(at(profile.root, 'composer.json'))?.require?.php;
  if (['phpcs', 'phpstan', 'phpunit'].includes(id)) {
    const pkg = { phpcs: 'squizlabs/php_codesniffer', phpstan: 'phpstan/phpstan', phpunit: 'phpunit/phpunit' }[id];
    const lock = documents.get(at(profile.root, 'composer.lock'));
    manifest = [...(lock?.packages ?? []), ...(lock?.['packages-dev'] ?? [])].find(p => p.name === pkg)?.version?.replace(/^v/, '');
  }
  if (configured && exact(manifest) && configured !== manifest) throw qualityError('configuration', `quality ${id} pin conflicts with project manifest`);
  return configured ?? (exact(manifest) ? manifest : undefined);
}

export class QualityProfileRegistry {
  constructor() { this.languages = qualityLanguages; }
  async _discover(project) {
    const root = path.resolve(project), files = await qualityInventory(root), names = new Set(files.map(f => f.path));
    const documents = new Map(), frameworks = new Set(), frameworkEvidence = [];
    const markFramework = (framework, name) => { frameworks.add(framework); frameworkEvidence.push({ framework, root: dir(name) }); };
    for (const name of names) {
      const base = path.posix.basename(name);
      if (['package.json', 'package-lock.json', 'composer.json', 'composer.lock', 'global.json', 'kodo.config.json'].includes(base)) documents.set(name, await json(root, name));
      else if (['Cargo.toml', 'rust-toolchain.toml'].includes(base)) {
        try { documents.set(name, parseToml(await readFile(path.join(root, name), 'utf8'))); }
        catch { throw qualityError('configuration', `invalid TOML manifest ${name}`); }
      } else if (base === 'go.mod') {
        const text = await readFile(path.join(root, name), 'utf8');
        if (!/^module\s+\S+/m.test(text)) throw qualityError('configuration', 'invalid go.mod manifest'); documents.set(name, text);
      }
      if (/^(?:next|astro)\.config\.(?:[cm]?js|ts)$/.test(base)) markFramework(base.startsWith('next') ? 'next' : 'astro', name);
      if (name.endsWith('.astro')) markFramework('astro', name);
      if (base === 'package.json') {
        const pkg = documents.get(name), deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        for (const [key, framework] of [['react', 'react'], ['next', 'next'], ['astro', 'astro']]) if (typeof deps[key] === 'string' && deps[key].trim()) markFramework(framework, name);
      }
      if (base === 'composer.json' && Object.keys({ ...documents.get(name).require, ...documents.get(name)['require-dev'] }).some(key => /^(?:wpackagist-|johnpbloch\/wordpress|roots\/wordpress)/.test(key))) markFramework('wordpress', name);
      if (name.endsWith('.php') && /(?:Plugin Name\s*:|Theme Name\s*:|\b(?:add_action|add_filter|register_block_type)\s*\()/i.test(await readFile(path.join(root, name), 'utf8'))) markFramework('wordpress', name);
    }
    for (const [name, doc] of documents) if (name.endsWith('package-lock.json')) {
      const pkg = documents.get(at(dir(name), 'package.json')), locked = doc.packages?.[''];
      if (!pkg || ![1, 2, 3].includes(doc.lockfileVersion)) throw qualityError('configuration', 'mismatched package lock manifest');
      if (doc.lockfileVersion >= 2 && (!object(locked) || ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => JSON.stringify(Object.entries(pkg[key] ?? {}).sort()) !== JSON.stringify(Object.entries(locked[key] ?? {}).sort())))) throw qualityError('configuration', 'package lock dependencies differ from manifest');
    }
    await validateManifestScope(root, files, documents);
    const config = normalizeQualityConfig(documents.get('kodo.config.json')?.quality);
    const languageFiles = files.filter(f => languageOf(f.path)); const profiles = [];
    for (const language of qualityLanguages) {
      const roots = [...new Set(files.filter(f => ({ csharp: /\.csproj$/, rust: /(?:^|\/)Cargo\.toml$/, go: /(?:^|\/)go\.mod$/, php: /(?:^|\/)composer\.json$/, typescript: /(?:^|\/)package\.json$/, javascript: /(?:^|\/)package\.json$/, css: /(?:^|\/)package\.json$/, html: /(?:^|\/)package\.json$/, sql: /(?:^|\/)package\.json$/ })[language].test(f.path)).map(f => dir(f.path)))].sort((a, b) => b.length - a.length || a.localeCompare(b));
      const grouped = new Map();
      for (const file of languageFiles.filter(f => languageOf(f.path) === language)) {
        const owner = roots.find(r => beneath(r, file.path)) ?? '';
        if (!grouped.has(owner)) grouped.set(owner, []); grouped.get(owner).push(file.path);
      }
      for (const [owner, sources] of [...grouped].sort()) {
        // Include real same-directory manifests/configs/locks, not directory names.
        const metadata = files.filter(f => dir(f.path) === owner && /(?:\.csproj$|\.slnx?$|(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|Cargo\.(?:toml|lock)|rust-toolchain\.toml|go\.(?:mod|sum)|composer\.(?:json|lock)|global\.json|next\.config\.[^/]+|astro\.config\.[^/]+|\.stylelintrc[^/]*|stylelint\.config\.[^/]+|\.htmlvalidate[^/]*|\.sqlfluff|\.editorconfig))/.test(f.path)).map(f => f.path);
        const ownFrameworks = [...new Set(frameworkEvidence.filter(e => e.root === owner || beneath(owner, at(e.root, '_')) && sources.some(name => beneath(e.root, name))).map(e => e.framework))].sort();
        profiles.push({ id: `${language}:${owner || '.'}`, language, root: owner, files: sources.sort(), manifests: metadata, frameworks: ownFrameworks });
      }
    }
    const result = { schemaVersion: 1, status: profiles.length ? 'applicable' : 'not_applicable', project: root, languages: qualityLanguages.filter(l => profiles.some(p => p.language === l)), frameworks: [...frameworks].sort(), profiles, files, sourceHash: sha256(JSON.stringify(files)), config, configHash: sha256(JSON.stringify(config)) };
    // The internal documents are not returned (source/credentials never become a report).
    return { result, documents };
  }
  async detect(project) { return (await this.discover(project)).result; }
  async discover(project) { return this._discover(project); }
  async plan(project, options = {}) {
    const { result: report, documents } = await this.discover(project), { config } = report;
    const mode = options.mode ?? config.mode;
    if (!['quick', 'standard', 'deep'].includes(mode)) throw qualityError('configuration', 'invalid quality mode');
    const changed = options.changedPaths ?? config.changedPaths;
    const affected = options.affectedPaths ?? config.affectedPaths;
    for (const list of [changed ?? [], affected]) if (!Array.isArray(list) || list.length > 20000) throw qualityError('configuration', 'invalid quality scope');
    const names = new Set(report.files.map(f => f.path));
    for (const name of [...(changed ?? []), ...affected]) {
      qualityPath(name); if (!names.has(name)) throw qualityError('unsafe_path', 'quality changed/affected path is missing or excluded');
    }
    const selected = options.capabilities ?? qualityCapabilities;
    if (!Array.isArray(selected) || !selected.length || selected.some(c => !qualityCapabilities.includes(c)) || new Set(selected).size !== selected.length) throw qualityError('configuration', 'invalid quality capabilities');
    const changedPaths = changed === null ? null : [...new Set(changed)].sort(), scope = changedPaths === null ? null : new Set([...changedPaths, ...affected]);
    const checks = [];
    for (const profile of report.profiles) for (const capability of selected) {
      const files = mode === 'quick' && scope ? profile.files.filter(f => scope.has(f)) : profile.files;
      let check = { id: `${profile.id}:${capability}`, profile: profile.id, language: profile.language, root: profile.root, capability, files, frameworks: profile.frameworks, status: 'applicable', tool: null, version: null, scopeReason: mode === 'quick' && scope === null ? 'unknown changed paths; inspect all discovered source files' : null };
      if (!config.enabled) check = { ...check, status: 'disabled', reason: 'quality_disabled' };
      else if (!config.capabilities[capability]) check = { ...check, status: 'disabled', reason: 'capability_disabled' };
      else if (!files.length) check = { ...check, status: 'skipped', reason: 'no_changed_or_affected_source' };
      else if (['test', 'security', 'architecture', 'release'].includes(capability)) check = { ...check, status: 'skipped', reason: 'explicit_configured_check_required' };
      else {
        const tools = { csharp: { format: 'dotnet', lint: 'dotnet', typecheck: 'dotnet' }, rust: { format: 'rustfmt', lint: 'cargo', typecheck: 'cargo' }, go: { format: 'gofmt', lint: 'go', typecheck: 'go' }, typescript: { format: 'oxfmt', lint: 'oxlint', typecheck: 'typescript' }, javascript: { format: 'oxfmt', lint: 'oxlint' }, css: { format: 'oxfmt', lint: 'stylelint' }, html: { format: 'oxfmt', lint: 'html-validate' }, php: { format: 'phpcs', lint: 'php', typecheck: 'phpstan' }, sql: { format: 'sqlfluff', lint: 'sqlfluff' } };
        check.tool = tools[profile.language][capability];
        if (!check.tool) check = { ...check, status: 'not_applicable', reason: 'no_builtin_language_capability' };
        else {
          check.version = managed.get(check.tool)?.version ?? nativePin(profile, check.tool, config, documents) ?? null;
          if (!check.version) check = { ...check, status: 'missing', reason: 'exact_project_tool_pin_required' };
          if (profile.language === 'sql' && !config.dialect) check = { ...check, status: 'blocked', reason: 'sql_dialect_required' };
          if (profile.language === 'sql' && config.dialect && !qualitySqlDialects.includes(config.dialect)) check = { ...check, status: 'unsupported', reason: 'unsupported_sql_dialect' };
          if (profile.language === 'sql') check.dialect = config.dialect;
          if (profile.language === 'csharp') {
            const manifests = profile.manifests.filter(f => f.endsWith('.csproj'));
            if (manifests.length !== 1) check = { ...check, status: 'blocked', reason: 'unambiguous_csproj_required' };
            check.manifest = manifests[0];
          }
          if (profile.language === 'rust') {
            check.manifest = at(profile.root, 'Cargo.toml'); check.edition = String(documents.get(check.manifest)?.package?.edition ?? '2015');
            if (!names.has(check.manifest) || !['2015', '2018', '2021', '2024'].includes(check.edition)) check = { ...check, status: 'blocked', reason: 'rust_manifest_and_edition_required' };
            if (check.tool === 'cargo' && !names.has(at(profile.root, 'Cargo.lock'))) check = { ...check, status: 'missing', reason: 'cargo_lock_required' };
            if (check.tool === 'cargo') {
              check.rustcVersion = nativePin(profile, 'rustc', config, documents) ?? null;
              if (!check.rustcVersion) check = { ...check, status: 'missing', reason: 'exact_rustc_pin_required' };
              if (capability === 'lint') {
                check.clippyVersion = config.tools.clippy?.version ?? null;
                if (!check.clippyVersion) check = { ...check, status: 'missing', reason: 'exact_clippy_pin_required' };
              }
            }
          }
          if (check.tool === 'typescript') {
            check.manifest = at(profile.root, 'tsconfig.json');
            if (!names.has(check.manifest)) check = { ...check, status: 'blocked', reason: 'tsconfig_required' };
          }
          if (['typescript', 'cargo'].includes(check.tool) || check.tool === 'dotnet' && capability !== 'format' || check.tool === 'go' && capability !== 'format') {
            check.files = profile.files;
            check.scopeReason = 'compiler/analyzer dependency graph is project-wide; selected source requires its owning project';
          }
          if (check.tool === 'stylelint' && !profile.manifests.some(f => /stylelint/.test(f))) check = { ...check, status: 'blocked', reason: 'stylelint_project_config_required' };
          if (check.tool === 'html-validate' && !profile.manifests.some(f => /htmlvalidate/.test(f))) check = { ...check, status: 'blocked', reason: 'htmlvalidate_project_config_required' };
          if (check.tool === 'html-validate' && [...names].some(f => path.posix.basename(f) === '.htmlvalidateignore')) check = { ...check, status: 'blocked', reason: 'html_ignore_requires_explicit_project_check' };
          if (['phpcs', 'phpstan'].includes(check.tool)) {
            check.phpVersion = nativePin(profile, 'php', config, documents) ?? null;
            check.entry = config.tools[check.tool]?.path ?? `vendor/${{ phpcs: 'squizlabs/php_codesniffer/bin/phpcs', phpstan: 'phpstan/phpstan/phpstan' }[check.tool]}`;
            if (!check.phpVersion) check = { ...check, status: 'missing', reason: 'exact_php_runtime_pin_required' };
          }
        }
      }
      checks.push(check);
    }
    for (const entry of config.checks.filter(c => selected.includes(c.capability))) {
      const candidates = entry.files.filter(f => names.has(f));
      if (candidates.length !== entry.files.length) throw qualityError('unsafe_path', 'configured quality check source is missing');
      const relevant = scope === null || entry.files.some(f => scope.has(f));
      if (mode === 'quick' && relevant && scope && entry.files.some(f => !scope.has(f)) && !entry.scopeReason) throw qualityError('configuration', 'configured quality check widening requires explicit dependency scopeReason');
      const check = { id: `configured:${entry.id}`, language: entry.language ?? null, root: '', capability: entry.capability, tool: entry.command, version: entry.version, files: entry.files, status: !config.enabled || !config.capabilities[entry.capability] ? 'disabled' : !relevant && mode === 'quick' ? 'skipped' : 'applicable', scopeReason: entry.scopeReason ?? (scope === null ? 'unknown changed paths; explicitly configured check' : null), configured: entry };
      checks.push(check);
      // A configured receipt replaces the neutral placeholder, never a built-in check.
      for (let i = checks.length - 2; i >= 0; i--) if (checks[i].capability === entry.capability && checks[i].reason === 'explicit_configured_check_required' && (!entry.language || checks[i].language === entry.language)) checks.splice(i, 1);
    }
    const status = checks.some(c => ['missing', 'unsupported', 'blocked'].includes(c.status)) ? 'blocked' : checks.some(c => c.status === 'applicable') ? 'applicable' : !config.enabled ? 'disabled' : checks.length ? 'skipped' : 'not_applicable';
    return { ...report, status, mode, selectedCapabilities: selected, changedPaths, affectedPaths: [...new Set(affected)].sort(), checks };
  }
}
