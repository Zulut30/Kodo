import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { destination } from '../cli/installer.mjs';
import { safeRelative } from '../cli/catalog.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const replace = text => text.replaceAll('.ai-toolkit', '.kodo').replaceAll('AI Toolkit', 'Kodo').replaceAll('ai-toolkit', 'kodo').replaceAll('aitk-', 'kodo-').replaceAll('aitk_', 'kodo_');
async function exists(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export async function migrate(target) {
  const oldLock = await destination(target, '.ai-toolkit/lock.json');
  if (!await exists(oldLock)) return { migrated: false, reason: 'legacy_not_found' };
  if (await exists(await destination(target, '.kodo/lock.json'))) throw new Error('Уже существует установка Kodo; автоматическое объединение запрещено');
  const record = JSON.parse(await readFile(oldLock, 'utf8'));
  if (record.schemaVersion !== 1 || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) throw new Error('Некорректный legacy lock');
  const changes = [], files = {};
  for (const [relative, meta] of Object.entries(record.files)) {
    safeRelative(relative);
    if (!/^(\.ai-toolkit\/components\/|\.agents\/skills\/|\.claude\/(agents|skills)\/|\.opencode\/agents\/)/.test(relative)) throw new Error('Недопустимый legacy путь');
    const source = await destination(target, relative), stat = await exists(source);
    if (!stat?.isFile()) throw new Error(`Отсутствует исходный файл: ${relative}`);
    const before = await readFile(source);
    if (hash(before) !== meta.sha256) throw new Error(`Файл изменён пользователем: ${relative}`);
    const next = replace(relative), dest = await destination(target, next);
    if (next !== relative && await exists(dest)) throw new Error(`Конфликт миграции: ${next}`);
    const data = before.includes(0) ? before : Buffer.from(replace(before.toString('utf8')));
    changes.push({ source, dest, next, before, data }); files[next] = { ...meta, sha256: hash(data) };
  }
  const applied = [];
  async function put(filename, data) { await mkdir(path.dirname(filename), { recursive: true }); const temporary = `${filename}.kodo-${randomUUID()}.tmp`; try { await writeFile(temporary, data, { flag: 'wx' }); await rename(temporary, filename); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); } }
  const newLock = await destination(target, '.kodo/lock.json');
  try {
    for (const item of changes) { await put(item.dest, item.data); applied.push(item); }
    await put(newLock, Buffer.from(JSON.stringify({ ...record, files }, null, 2) + '\n'));
  } catch (error) {
    for (const item of applied.reverse()) { if (item.source === item.dest) await put(item.source, item.before); else await unlink(item.dest); }
    throw error;
  }
  for (const item of changes) if (item.source !== item.dest) await unlink(item.source);
  await unlink(oldLock); return { migrated: true, files: changes.length };
}
