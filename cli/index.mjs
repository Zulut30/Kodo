#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, resolveComponents } from './catalog.mjs';
import { planInstallation, applyInstallation } from './installer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Kodo — Codex / Claude Code / OpenCode

node cli/index.mjs list [skill|agent|pipeline|mcp|preset] [--search TEXT] [--json]
node cli/index.mjs show <category/name> [--json]
node cli/index.mjs plan <pipelines/name> [--json]
node cli/index.mjs install <category/name> [...] --client <name|all> --target <project> [--dry-run] [--json]
node cli/index.mjs init --preset <nextjs|dotnet|wordpress> --client <name|all> --target <project> [--dry-run] [--json]
node cli/index.mjs validate [--json]
kodo registry stats [--json]

kodo init [--project PATH]
kodo doctor [--live] [--json]
kodo run "TASK" --client codex|claude-code [--model MODEL] [--mode quick|standard|deep] [--providers both] [--prepare] [--delivery none|pr|release]
kodo benchmark run --models MODEL,... [--client codex|claude-code] [--mode quick|standard|deep] [--repeats N] [--seed N] [--output ABSOLUTE_DIR] [--json]
kodo benchmark resume|report PATH [--json]
kodo status|logs|resume|cancel RUN_ID [--json]
kodo audit RUN_ID [--json]
kodo tools list|doctor [--live] [--json]
kodo tools install <id|all> [--json]
kodo quality detect|plan|run [--project PATH] [--json]
kodo quality run [--mode quick|standard|deep] [--changed PATH] [--affected PATH] [--capability NAME] [--evidence-dir PATH]
kodo ui verify [--project PATH] [--json]
kodo security verify [--project PATH] [--json]
kodo resume RUN_ID --plan FILE
kodo migrate --target PROJECT

Клиенты: codex, claude-code, opencode. --client можно повторять.
Установка локальная; MCP устанавливаются как шаблоны, без подключения.
run выполняет задачу через клиенты по подписке. plan показывает каталог пайплайнов.`;

function parse(argv) {
  const options = { clients: [], positional: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--json', '--dry-run', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--client', '--target', '--preset', '--search'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Требуется значение ${arg}`);
      if (arg === '--client') options.clients.push(value);
      else {
        if (options[arg.slice(2)] !== undefined) throw new Error(`Повторный параметр: ${arg}`);
        options[arg.slice(2)] = value;
      }
    } else if (arg.startsWith('-')) throw new Error(`Неизвестный параметр: ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function checkOptions(command, options) {
  const allowed = {
    list: ['json', 'search'], show: ['json'], plan: ['json'], validate: ['json'], registry: ['json'],
    install: ['json', 'dry-run', 'target', 'clients'], init: ['json', 'dry-run', 'target', 'clients', 'preset']
  }[command];
  if (!allowed) throw new Error(`Неизвестная команда: ${command}`);
  for (const key of Object.keys(options)) if (key !== 'positional' && !(key === 'clients' && !options.clients.length) && !allowed.includes(key)) throw new Error(`Параметр ${key} неприменим к ${command}`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) return console.log(help);
  // Offline reports and argument errors must not initialize the runtime's
  // SQLite store or credential/provider startup path.
  if (command === 'quality') {
    const { qualityCli } = await import('../runtime/quality-cli.mjs');
    const result = await qualityCli(argv); console.log(result.output); process.exitCode = result.exitCode; return;
  }
  if (command === 'benchmark') {
    const { benchmarkCli } = await import('../runtime/benchmark-cli.mjs');
    const result = await benchmarkCli(argv); console.log(result.output); process.exitCode = result.exitCode; return;
  }
  if (['doctor','run','status','logs','resume','cancel','migrate','audit','tools','ui','security'].includes(command) || command === 'init' && !argv.includes('--preset')) {
    const { runtimeCli } = await import('../runtime/cli.mjs');
    return runtimeCli(command, argv);
  }
  const options = parse(argv);
  if (options.help) return console.log(help);
  checkOptions(command, options);
  const catalog = await loadCatalog(root);
  const ids = options.positional;
  const output = value => console.log(JSON.stringify(value, null, 2));
  if (command === 'registry') {
    if (ids.length !== 1 || ids[0] !== 'stats') throw new Error('Использование: kodo registry stats [--json]');
    const byType = { skill: 0, agent: 0, pipeline: 0, mcp: 0, preset: 0 };
    let dependencies = 0;
    for (const component of catalog.registry.components) {
      byType[component.type]++;
      dependencies += component.requires.length;
    }
    const result = {
      version: catalog.registry.version,
      total: catalog.registry.components.length,
      byType,
      dependencies
    };
    if (options.json) return output(result);
    const rows = [
      ['Показатель', 'Значение'],
      ['Версия registry', result.version],
      ['Всего компонентов', result.total],
      ...Object.entries(result.byType),
      ['Ссылок requires', result.dependencies]
    ];
    return console.log(rows.map(([label, value]) => `${label.padEnd(20)} | ${value}`).join('\n'));
  }
  if (command === 'validate') {
    if (ids.length) throw new Error('validate не принимает аргументы');
    const result = { valid: true, version: catalog.registry.version, components: catalog.registry.components.length };
    return options.json ? output(result) : console.log(`Каталог корректен: ${result.components} компонентов, версия ${result.version}`);
  }
  if (command === 'list') {
    if (ids.length > 1 || ids[0] && !['skill', 'agent', 'pipeline', 'mcp', 'preset'].includes(ids[0])) throw new Error('Укажи тип: skill, agent, pipeline, mcp или preset');
    const normalize = text => String(text ?? '').normalize('NFC').toLocaleLowerCase('ru');
    const query = options.search === undefined ? '' : normalize(options.search.trim());
    if (options.search !== undefined && !query) throw new Error('Требуется значение --search');
    const list = catalog.registry.components.filter(item => (!ids[0] || item.type === ids[0]) && (!query || normalize(item.id).includes(query) || normalize(item.description).includes(query)));
    if (query && !list.length && !options.json) return;
    return options.json ? output(list) : console.log(list.map(item => `${item.id.padEnd(29)} ${item.description}`).join('\n'));
  }
  if (command === 'show' || command === 'plan') {
    if (ids.length !== 1) throw new Error(`${command} требует один id компонента`);
    const component = catalog.registry.components.find(item => item.id === ids[0]);
    if (!component) throw new Error(`Неизвестный компонент: ${ids[0]}`);
    if (command === 'plan' && component.type !== 'pipeline') throw new Error('plan принимает только pipelines/name');
    const content = catalog.bundles.get(component.id).get(component.entry).toString('utf8');
    const dependencies = resolveComponents(catalog.registry, component.requires).map(item => item.id);
    if (options.json) return output({ ...component, dependencies, content: component.type === 'pipeline' ? JSON.parse(content) : content });
    return console.log(`${component.id} v${component.version}\n${component.description}\nЗависимости: ${dependencies.join(', ') || 'нет'}\n\n${content}`);
  }
  if (!options.target) throw new Error('Укажи --target <папка проекта>');
  let selected = ids;
  if (command === 'init') {
    if (ids.length || !options.preset || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.preset)) throw new Error('init требует --preset <name> без позиционных аргументов');
    selected = [`presets/${options.preset}`];
  }
  if (!selected.length) throw new Error('Укажи хотя бы один компонент');
  const plan = await planInstallation(catalog, selected, options.clients, options.target);
  if (!options['dry-run']) await applyInstallation(plan);
  const result = {
    dryRun: Boolean(options['dry-run']), target: plan.root, clients: plan.clients, components: plan.components,
    files: plan.changes.map(({ path: name, status }) => ({ path: name, status }))
  };
  if (options.json) return output(result);
  console.log(`${result.dryRun ? 'План установки' : 'Установлено'} → ${plan.root}\nКлиенты: ${plan.clients.join(', ')}\nКомпонентов: ${plan.components.length}\n` + result.files.map(item => `${item.status.padEnd(9)} ${item.path}`).join('\n'));
}

main().catch(error => { console.error(`Ошибка: ${error.message}`); process.exitCode = 1; });
