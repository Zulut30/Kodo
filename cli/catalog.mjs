import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const categories = { skills: 'skill', agents: 'agent', pipelines: 'pipeline', mcp: 'mcp', presets: 'preset' };
const entries = { skill: 'SKILL.md', agent: 'AGENT.md', pipeline: 'pipeline.json', mcp: 'README.md', preset: 'PRESET.md' };
const versionPattern = /^\d+\.\d+\.\d+$/;
const idPattern = /^(skills|agents|pipelines|mcp|presets)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f<>:"|?*]/.test(value) || path.posix.isAbsolute(value)) {
    throw new Error(`Небезопасный относительный путь: ${JSON.stringify(value)}`);
  }
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw new Error(`Небезопасный относительный путь: ${value}`);
  }
  return value;
}

export async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { throw new Error(`Не удалось прочитать JSON ${filename}: ${error.message}`); }
}

export async function readBundle(directory) {
  const files = new Map();
  async function walk(absolute, relative = '') {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Ссылки в компонентах запрещены: ${absolute}`);
    if (stat.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      for (const name of names) await walk(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      safeRelative(relative);
      files.set(relative, await readFile(absolute));
    } else throw new Error(`Неподдерживаемый тип файла: ${absolute}`);
  }
  await walk(directory);
  return files;
}

export function resolveComponents(registry, ids) {
  const byId = new Map(registry.components.map(component => [component.id, component]));
  const visited = new Set(), active = new Set(), result = [];
  function visit(id) {
    if (active.has(id)) throw new Error(`Цикл зависимостей: ${[...active, id].join(' → ')}`);
    if (visited.has(id)) return;
    const component = byId.get(id);
    if (!component) throw new Error(`Неизвестный компонент: ${id}`);
    active.add(id);
    for (const dependency of component.requires) visit(dependency);
    active.delete(id);
    visited.add(id);
    result.push(component);
  }
  ids.forEach(visit);
  return result;
}

export function validateManifest(registry) {
  if (!registry || registry.schemaVersion !== 1 || !versionPattern.test(registry.version) || !Array.isArray(registry.components) || !registry.components.length) {
    throw new Error('Некорректный registry.json: ожидаются schemaVersion=1, version и непустой components');
  }
  const ids = new Set();
  for (const component of registry.components) {
    if (!component || !idPattern.test(component.id) || component.id.length > 96) throw new Error('Некорректный id компонента');
    const category = component.id.split('/')[0];
    if (categories[category] !== component.type || component.entry !== entries[component.type]) throw new Error(`Некорректные type/entry: ${component.id}`);
    if (ids.has(component.id)) throw new Error(`Повторный id: ${component.id}`);
    ids.add(component.id);
    if (!versionPattern.test(component.version) || typeof component.description !== 'string' || !component.description.trim()) throw new Error(`Некорректные метаданные: ${component.id}`);
    if (!Array.isArray(component.requires) || component.requires.some(id => !idPattern.test(id)) || new Set(component.requires).size !== component.requires.length) throw new Error(`Некорректные зависимости: ${component.id}`);
  }
  resolveComponents(registry, [...ids]);
  return registry;
}

export function validateSkill(text, expectedName) {
  // Toolkit sources deliberately use a small, single-line YAML frontmatter subset.
  const match = /^---\r?\nname: ([a-z0-9]+(?:-[a-z0-9]+)*)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(text);
  if (!match || match[1] !== expectedName || match[1].length > 64 || match[2].length > 1024 || !match[3].trim()) throw new Error(`Некорректный SKILL.md: ${expectedName}`);
}

export async function loadCatalog(root) {
  const registry = validateManifest(await readJson(path.join(root, 'registry.json')));
  const bundles = new Map();
  for (const component of registry.components) {
    const bundle = await readBundle(path.join(root, ...component.id.split('/')));
    if (!bundle.has(component.entry)) throw new Error(`Отсутствует ${component.id}/${component.entry}`);
    if (!bundle.get(component.entry).toString('utf8').trim()) throw new Error(`Пустой entry: ${component.id}/${component.entry}`);
    if (component.type === 'skill') validateSkill(bundle.get('SKILL.md').toString('utf8'), component.id.split('/')[1]);
    if (component.type === 'pipeline') {
      const pipeline = JSON.parse(bundle.get('pipeline.json').toString('utf8'));
      if (typeof pipeline.goal !== 'string' || !pipeline.goal.trim() || !Array.isArray(pipeline.steps) || !pipeline.steps.length) throw new Error(`Некорректный pipeline: ${component.id}`);
      const stepIds = new Set();
      for (const step of pipeline.steps) {
        const role = step.agent ?? step.skill;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.id) || stepIds.has(step.id) || Boolean(step.agent) === Boolean(step.skill) || !component.requires.includes(role) || !(step.agent ? role.startsWith('agents/') : role.startsWith('skills/')) || typeof step.task !== 'string' || !step.task.trim() || typeof step.output !== 'string' || !step.output.trim()) throw new Error(`Некорректный этап в ${component.id}`);
        stepIds.add(step.id);
      }
    }
    for (const [name, data] of bundle) if (name.endsWith('.json')) JSON.parse(data.toString('utf8'));
    bundles.set(component.id, bundle);
  }
  return { registry, bundles };
}
