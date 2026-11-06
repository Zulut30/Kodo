import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
const components = registry.components;

const kodo = (...args) =>
  spawnSync(process.execPath, ['cli/index.mjs', 'list', ...args], { cwd: root, encoding: 'utf8' });
const run = (...args) => spawnSync(process.execPath, ['cli/index.mjs', ...args], { cwd: root, encoding: 'utf8' });

function listJson(...args) {
  const result = kodo(...args, '--json');
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.ok(Array.isArray(value), 'ожидается JSON-массив');
  return value.map(item => item.id);
}

function expected(text, type) {
  const query = text.toLowerCase();
  return components
    .filter(item => !type || item.type === type)
    .filter(item => item.id.toLowerCase().includes(query) || item.description.toLowerCase().includes(query))
    .map(item => item.id);
}

function assertRejected(result) {
  assert.notEqual(result.status, 0, `ожидалась ошибка, stdout: ${result.stdout}`);
  assert.ok(result.stderr.trim(), 'ожидается сообщение об ошибке');
}

// Фрагменты берутся из реестра, чтобы тест не зависел от конкретного набора компонентов.
const idSample = components[0].id.split('/')[1];
const russianWord = components
  .flatMap(item => item.description.split(/[^а-яё]+/i))
  .find(word => /^[а-яё]{5,}$/i.test(word) && word.toLowerCase() !== word.toUpperCase());

test('поиск по id не зависит от регистра', () => {
  const lower = listJson('--search', idSample.toLowerCase());
  const upper = listJson('--search', idSample.toUpperCase());
  assert.ok(lower.includes(components[0].id));
  assert.deepEqual(lower, expected(idSample));
  assert.deepEqual(upper, lower);
});

test('поиск находит совпадения только в description', () => {
  const item = components.find(candidate => {
    const word = candidate.description
      .split(/\s+/)
      .find(part => part.length >= 5 && !candidate.id.toLowerCase().includes(part.toLowerCase()));
    return word && !components.some(other => other.id.toLowerCase().includes(word.toLowerCase()));
  });
  assert.ok(item, 'в реестре нужен компонент со словом описания, отсутствующим в id');
  const word = item.description
    .split(/\s+/)
    .find(part => part.length >= 5 && !components.some(other => other.id.toLowerCase().includes(part.toLowerCase())));
  const found = listJson('--search', word);
  assert.ok(found.includes(item.id));
  assert.deepEqual(found, expected(word));
});

test('русский запрос в разных регистрах даёт одинаковый непустой результат', () => {
  assert.ok(russianWord, 'в описаниях реестра нужен русский текст');
  const lower = listJson('--search', russianWord.toLowerCase());
  const upper = listJson('--search', russianWord.toUpperCase());
  assert.ok(lower.length > 0);
  assert.deepEqual(lower, expected(russianWord));
  assert.deepEqual(upper, lower);

  const sample = components.find(item => item.description.toLowerCase().includes('проверка'));
  if (sample) {
    const a = listJson('--search', 'проверка');
    assert.ok(a.length > 0);
    assert.deepEqual(a, expected('проверка'));
    assert.deepEqual(listJson('--search', 'ПРОВЕРКА'), a);
    assert.deepEqual(listJson('--search', 'Проверка'), a);
  }
});

test('поиск сочетается с фильтром типа', () => {
  const types = [...new Set(components.map(item => item.type))];
  for (const type of types) {
    for (const query of [russianWord, idSample, type.slice(0, 3)]) {
      const result = kodo(type, '--search', query, '--json');
      assert.equal(result.status, 0, result.stderr);
      const items = JSON.parse(result.stdout);
      assert.ok(
        items.every(item => item.type === type),
        `все элементы должны быть типа ${type}`,
      );
      assert.deepEqual(
        items.map(item => item.id),
        expected(query, type),
      );
    }
  }
  // Порядок аргументов не важен.
  const type = components[0].type;
  assert.deepEqual(listJson('--search', idSample, type), expected(idSample, type));
});

test('--json выдаёт массив без дублей в порядке реестра', () => {
  const order = components.map(item => item.id);
  for (const query of ['s', 'а', russianWord, idSample]) {
    const ids = listJson('--search', query);
    assert.equal(new Set(ids).size, ids.length, `дубли id для запроса ${query}`);
    const positions = ids.map(id => order.indexOf(id));
    assert.ok(positions.every(position => position >= 0));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
    assert.deepEqual(ids, expected(query));
  }
  const result = kodo('--search', idSample, '--json');
  const items = JSON.parse(result.stdout);
  const byId = Object.fromEntries(components.map(item => [item.id, item]));
  for (const item of items) assert.equal(item.description, byId[item.id].description);
});

test('пустой результат: [] в JSON и код 0', () => {
  const query = 'zzq-нет-такого-компонента-9431';
  assert.deepEqual(expected(query), []);
  const json = kodo('--search', query, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), []);
  const text = kodo('--search', query);
  assert.equal(text.status, 0, text.stderr);
  for (const item of components) assert.ok(!text.stdout.includes(item.id));
});

test('текстовый вывод содержит только найденные компоненты', () => {
  const result = kodo('--search', idSample);
  assert.equal(result.status, 0, result.stderr);
  const found = new Set(expected(idSample));
  for (const item of components) assert.equal(result.stdout.includes(item.id), found.has(item.id), item.id);
});

test('ошибки аргументов --search', () => {
  assertRejected(kodo('--search'));
  assertRejected(kodo('--search', '--json'));
  assertRejected(kodo('--search', idSample, '--search', russianWord));
  assertRejected(kodo('--search', idSample, '--search', idSample, '--json'));
});

test('--search неприменим к команде show', () => {
  assertRejected(run('show', components[0].id, '--search', idSample));
});

test('list без --search возвращает весь каталог', () => {
  assert.deepEqual(
    listJson(),
    components.map(item => item.id),
  );
  const type = components[0].type;
  assert.deepEqual(
    listJson(type),
    components.filter(item => item.type === type).map(item => item.id),
  );
});
