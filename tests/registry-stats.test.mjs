import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli/index.mjs');
// Read the manifest as public data; never import the statistics implementation.
const registry = JSON.parse(await readFile(path.join(root, 'registry.json'), 'utf8'));
const expectedStats = {
  version: '0.2.0',
  total: 33,
  byType: { skill: 18, agent: 5, pipeline: 4, mcp: 3, preset: 3 },
  dependencies: 51
};

// Independently checked manifest order and existing text output, including spacing.
const listRows = [
  ['skills/code-review', 'skills/code-review            Проверка изменений кода с доказуемыми замечаниями'],
  ['skills/ui-audit', 'skills/ui-audit               Аудит интерфейса и пользовательского сценария'],
  ['skills/bug-hunting', 'skills/bug-hunting            Воспроизведение ошибки и поиск первопричины'],
  ['skills/seo-audit', 'skills/seo-audit              Технический SEO-аудит с разделением фактов и гипотез'],
  ['agents/architect', 'agents/architect              Проектирование границ, контрактов и плана изменений'],
  ['agents/developer', 'agents/developer              Реализация согласованного поведения в коде'],
  ['agents/designer', 'agents/designer               Проработка пользовательских сценариев и состояний UI'],
  ['agents/qa-engineer', 'agents/qa-engineer            Проверка требований и регрессий на наблюдаемых результатах'],
  ['pipelines/build-feature', 'pipelines/build-feature       Реализация функции от требований до проверки'],
  ['pipelines/fix-bug', 'pipelines/fix-bug             Исправление воспроизводимого дефекта'],
  ['pipelines/release-app', 'pipelines/release-app         Подготовка проверяемого релизного артефакта'],
  ['pipelines/build-website', 'pipelines/build-website       Создание сайта с проверкой UI и SEO'],
  ['mcp/github', 'mcp/github                    Шаблоны GitHub MCP для трёх клиентов'],
  ['mcp/browser', 'mcp/browser                   Шаблоны Playwright MCP с изолированным профилем'],
  ['mcp/database', 'mcp/database                  Шаблоны Supabase MCP с ограничением на один проект'],
  ['presets/nextjs', 'presets/nextjs                Комплект для Next.js-проекта'],
  ['presets/dotnet', 'presets/dotnet                Комплект для .NET-приложения'],
  ['presets/wordpress', 'presets/wordpress             Комплект для WordPress-сайта или плагина'],
  ['agents/documenter', 'agents/documenter             Документирование реализованного поведения и команд проекта'],
  ['skills/kodo-build-feature', 'skills/kodo-build-feature     Выполнение задачи через движок Kodo с анализом планом агентами проверками и доставкой'],
  ['skills/architecture-patterns', 'skills/architecture-patterns  Стандарт Kodo architecture patterns'],
  ['skills/architecture-decision-records', 'skills/architecture-decision-records Стандарт Kodo architecture decision records'],
  ['skills/monorepo-management', 'skills/monorepo-management    Стандарт Kodo monorepo management'],
  ['skills/e2e-testing-patterns', 'skills/e2e-testing-patterns   Стандарт Kodo e2e testing patterns'],
  ['skills/subagent-driven-development', 'skills/subagent-driven-development Стандарт Kodo subagent driven development'],
  ['skills/systematic-debugging', 'skills/systematic-debugging   Стандарт Kodo systematic debugging'],
  ['skills/test-driven-development', 'skills/test-driven-development Стандарт Kodo test driven development'],
  ['skills/using-git-worktrees', 'skills/using-git-worktrees    Стандарт Kodo using git worktrees'],
  ['skills/differential-review', 'skills/differential-review    Стандарт Kodo differential review'],
  ['skills/react-best-practices', 'skills/react-best-practices   Стандарт Kodo react best practices'],
  ['skills/composition-patterns', 'skills/composition-patterns   Стандарт Kodo composition patterns'],
  ['skills/ce-compound', 'skills/ce-compound            Стандарт Kodo ce compound'],
  ['skills/spec-kit', 'skills/spec-kit               Стандарт Kodo spec kit']
];
const skillRows = [listRows[0], listRows[1], listRows[2], listRows[3], ...listRows.slice(19)];

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', cwd, timeout: 30_000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'CLI must exit normally');
  return result;
}

function successful(args, cwd) {
  const result = run(args, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

const workingDirectories = [
  ['project directory', root],
  ['unrelated working directory', os.tmpdir()]
];

test('Registry stats JSON has exactly the required keys, types and values', async t => {
  assert.notEqual(path.resolve(os.tmpdir()), root);
  for (const [name, cwd] of workingDirectories) await t.test(name, () => {
    // Parse all stdout so banners, tables and trailing messages are rejected.
    const stats = JSON.parse(successful(['registry', 'stats', '--json'], cwd));
    assert.ok(stats !== null && typeof stats === 'object' && !Array.isArray(stats));
    assert.deepEqual(Object.keys(stats).sort(), ['byType', 'dependencies', 'total', 'version']);
    assert.equal(typeof stats.version, 'string');
    assert.ok(stats.byType !== null && typeof stats.byType === 'object' && !Array.isArray(stats.byType));
    assert.deepEqual(Object.keys(stats.byType).sort(), ['agent', 'mcp', 'pipeline', 'preset', 'skill']);
    for (const value of [stats.total, stats.dependencies, ...Object.values(stats.byType)]) {
      assert.equal(typeof value, 'number');
      assert.ok(Number.isInteger(value) && value >= 0);
    }
    assert.deepEqual(stats, expectedStats);
  });
});

test('Registry dependencies counts 51 direct requires references including repeated targets', () => {
  // Audited direct edges: 4 + 4 + 3 + 7 + 7 + 5 + 6 + 15 = 51.
  // There are only 29 distinct targets, and presets point to pipelines with
  // dependencies of their own. Deduplication or transitive expansion is wrong.
  const directReferenceCounts = [
    ['pipelines/build-feature', 4],
    ['pipelines/fix-bug', 4],
    ['pipelines/release-app', 3],
    ['pipelines/build-website', 7],
    ['presets/nextjs', 7],
    ['presets/dotnet', 5],
    ['presets/wordpress', 6],
    ['skills/kodo-build-feature', 15]
  ];
  assert.deepEqual(
    registry.components.filter(item => item.requires.length > 0).map(item => [item.id, item.requires.length]),
    directReferenceCounts
  );
  assert.equal(new Set(registry.components.flatMap(item => item.requires)).size, 29);
  const stats = JSON.parse(successful(['registry', 'stats', '--json']));
  assert.equal(stats.dependencies, 51);
});

test('Registry stats table associates every label with its value', async t => {
  const expectedRows = [
    ['Показатель', 'Значение'],
    ['Версия registry', '0.2.0'],
    ['Всего компонентов', '33'],
    ['skill', '18'],
    ['agent', '5'],
    ['pipeline', '4'],
    ['mcp', '3'],
    ['preset', '3'],
    ['Ссылок requires', '51']
  ];
  for (const [name, cwd] of workingDirectories) await t.test(name, () => {
    const stdout = successful(['registry', 'stats'], cwd);
    const rows = stdout.trimEnd().split(/\r?\n/).map(line => line.split('|').map(cell => cell.trim()));
    assert.deepEqual(rows, expectedRows);
  });
});

const invalidInvocations = [
  ['missing subcommand', ['registry']],
  ['unknown subcommand', ['registry', 'unknown']],
  ['extra positional argument', ['registry', 'stats', 'extra']],
  ['unknown flag', ['registry', 'stats', '--unknown']],
  ['inapplicable target', ['registry', 'stats', '--target', 'unused-project']],
  ['inapplicable client', ['registry', 'stats', '--client', 'codex']],
  ['inapplicable preset', ['registry', 'stats', '--preset', 'nextjs']],
  ['inapplicable dry run', ['registry', 'stats', '--dry-run']]
];

for (const [name, args] of invalidInvocations) {
  test(`Registry CLI rejects ${name} without stdout`, async t => {
    for (const [format, flags] of [['text', []], ['JSON', ['--json']]]) await t.test(format, () => {
      const result = run([...args, ...flags], os.tmpdir());
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^Ошибка:/);
    });
  });
}

test('CLI help advertises registry stats and its JSON option', () => {
  const stdout = successful(['--help'], os.tmpdir());
  assert.match(stdout, /^(?:kodo|node cli\/index\.mjs) registry stats \[--json\][ \t]*\r?$/m);
});

for (const [name, args, rows] of [
  ['list', ['list'], listRows],
  ['list skill', ['list', 'skill'], skillRows]
]) {
  test(`CLI ${name} preserves JSON contents, order and formatting`, () => {
    const stdout = successful([...args, '--json'], os.tmpdir());
    const items = JSON.parse(stdout);
    const ids = rows.map(([id]) => id);
    assert.ok(Array.isArray(items));
    assert.deepEqual(items.map(item => item.id), ids);
    const expected = ids.map(id => {
      const component = registry.components.find(item => item.id === id);
      assert.ok(component, `Missing manifest component: ${id}`);
      return component;
    });
    assert.deepEqual(items, expected);
    assert.equal(stdout, `${JSON.stringify(expected, null, 2)}\n`);
  });

  test(`CLI ${name} preserves text contents, order and formatting`, () => {
    const stdout = successful(args, os.tmpdir());
    assert.equal(stdout, `${rows.map(([, line]) => line).join('\n')}\n`);
  });
}
