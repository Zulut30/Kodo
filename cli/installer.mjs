import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeRelative, resolveComponents } from './catalog.mjs';
import { renderComponent, selectClients } from '../adapters/index.mjs';

const lockPath = '.kodo/lock.json';
const hash = data => createHash('sha256').update(data).digest('hex');
const sameBytes = (left, right) => (left === null ? right === null : right !== null && left.equals(right));
const allowedPath = value =>
  /^(\.agents\/skills\/|\.claude\/(skills|agents)\/|\.opencode\/agents\/|\.kodo\/components\/)/.test(value);

async function statOrNull(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function destination(root, relative) {
  safeRelative(relative);
  const absolute = path.resolve(root, ...relative.split('/'));
  // Inspect every existing ancestor, including the chosen project root.
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await statOrNull(current);
    if (stat?.isSymbolicLink()) throw new Error(`Путь содержит ссылку или junction: ${current}`);
    if (stat && index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Ожидалась папка: ${current}`);
  }
  return absolute;
}

function parseLock(data) {
  const lock = JSON.parse(data.toString('utf8'));
  if (!lock || lock.schemaVersion !== 1 || !lock.files || typeof lock.files !== 'object' || Array.isArray(lock.files))
    throw new Error('Некорректный .kodo/lock.json');
  for (const [name, meta] of Object.entries(lock.files)) {
    safeRelative(name);
    if (
      !allowedPath(name) ||
      !meta ||
      !/^[a-f0-9]{64}$/.test(meta.sha256) ||
      typeof meta.component !== 'string' ||
      typeof meta.version !== 'string'
    )
      throw new Error('Некорректная запись lock.json');
  }
  return lock;
}

export async function planInstallation(catalog, ids, clientNames, target) {
  const selectedClients = selectClients(clientNames);
  const components = resolveComponents(catalog.registry, ids);
  const root = path.resolve(target);
  const planned = new Map();
  function add(name, data, component) {
    safeRelative(name);
    if (!allowedPath(name)) throw new Error(`Путь установки не разрешён: ${name}`);
    const existing = planned.get(name);
    if (existing && !existing.data.equals(data)) throw new Error(`Компоненты конфликтуют: ${name}`);
    planned.set(name, { data, component: component.id, version: component.version });
  }
  for (const component of components) {
    const bundle = catalog.bundles.get(component.id);
    for (const [name, data] of bundle) add(`.kodo/components/${component.id}/${name}`, data, component);
    const dependencies = resolveComponents(catalog.registry, component.requires);
    for (const client of selectedClients)
      for (const [name, data] of renderComponent(component, bundle, dependencies, catalog.bundles, client))
        add(name, data, component);
  }
  const lockAbsolute = await destination(root, lockPath);
  const lockStat = await statOrNull(lockAbsolute);
  if (lockStat && !lockStat.isFile()) throw new Error(`Ожидался файл: ${lockAbsolute}`);
  const beforeLock = lockStat ? await readFile(lockAbsolute) : null;
  const lock = beforeLock
    ? parseLock(beforeLock)
    : { schemaVersion: 1, toolkitVersion: catalog.registry.version, files: {} };
  const changes = [];
  for (const [name, item] of planned) {
    const absolute = await destination(root, name);
    const stat = await statOrNull(absolute);
    if (stat && !stat.isFile()) throw new Error(`Конфликт с папкой: ${name}`);
    const before = stat ? await readFile(absolute) : null;
    const owned = Object.hasOwn(lock.files, name) ? lock.files[name] : null;
    if (before && !owned) throw new Error(`Файл не принадлежит Kodo: ${name}`);
    if (before && hash(before) !== owned.sha256) throw new Error(`Файл изменён пользователем: ${name}`);
    const sha256 = hash(item.data);
    const status = before ? (before.equals(item.data) ? 'unchanged' : 'update') : 'create';
    changes.push({ path: name, status, data: item.data, before });
    Object.defineProperty(lock.files, name, {
      value: { sha256, component: item.component, version: item.version },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  lock.toolkitVersion = catalog.registry.version;
  const orderedFiles = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b, 'en')));
  const nextLock = Buffer.from(JSON.stringify({ ...lock, files: orderedFiles }, null, 2) + '\n');
  return { root, clients: selectedClients, components: components.map(item => item.id), changes, beforeLock, nextLock };
}

async function atomicWrite(root, relative, data) {
  const filename = await destination(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await destination(root, relative);
  const temporary = path.join(path.dirname(filename), `.kodo-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function applyInstallation(plan) {
  // A per-project exclusive guard serializes toolkit installers. External editors
  // must not modify target files while an installation is running.
  const guard = '.kodo/install.guard';
  const guardAbsolute = await destination(plan.root, guard);
  await mkdir(path.dirname(guardAbsolute), { recursive: true });
  await destination(plan.root, guard);
  try {
    await writeFile(guardAbsolute, 'kodo installation\n', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Другая установка выполняется: .kodo/install.guard');
    throw error;
  }
  const applied = [];
  try {
    const lockAbsolute = await destination(plan.root, lockPath);
    const stat = await statOrNull(lockAbsolute);
    const currentLock = stat ? await readFile(lockAbsolute) : null;
    if (!sameBytes(currentLock, plan.beforeLock))
      throw new Error('lock.json изменился после планирования; повтори команду');
    // Recheck every file before the first mutation, including unchanged files.
    for (const change of plan.changes) {
      const filename = await destination(plan.root, change.path);
      const currentStat = await statOrNull(filename);
      const current = currentStat?.isFile() ? await readFile(filename) : null;
      if ((currentStat && !currentStat.isFile()) || !sameBytes(current, change.before))
        throw new Error(`Файл изменился после планирования: ${change.path}`);
    }
    for (const change of plan.changes.filter(item => item.status !== 'unchanged')) {
      await atomicWrite(plan.root, change.path, change.data);
      applied.push(change);
    }
    if (!plan.nextLock.equals(plan.beforeLock ?? Buffer.alloc(0)))
      await atomicWrite(plan.root, lockPath, plan.nextLock);
  } catch (error) {
    const rollbackErrors = [];
    for (const change of applied.reverse()) {
      try {
        if (change.before) await atomicWrite(plan.root, change.path, change.before);
        else await unlink(await destination(plan.root, change.path));
      } catch (rollbackError) {
        rollbackErrors.push(`${change.path}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length)
      throw new Error(`${error.message}\nНе удалось полностью откатить файлы:\n${rollbackErrors.join('\n')}`);
    throw error;
  } finally {
    await unlink(guardAbsolute);
  }
}
