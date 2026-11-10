import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readConfig, initConfig, normalizeConcurrency } from './config.mjs';
import { loadSecrets, redact, stateHome } from './security.mjs';
import { Store } from './store.mjs';
import { buildAuditReport, formatAuditReport } from './audit.mjs';
import { doctorProviders } from './providers.mjs';
import { openEngine } from './engine.mjs';
import { migrate } from './migration.mjs';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../cli/catalog.mjs';
import { planInstallation, applyInstallation } from '../cli/installer.mjs';
import { toolCatalog, doctorTools, installTools } from './tools.mjs';
import { runUIVerification, isCurrentUIReceipt } from './ui-verification.mjs';
import { runSecurityChecks, isCurrentSecurityReceipt } from './security-gates.mjs';
import { git } from './workspace.mjs';
import { writeProgress, assertPrivateArtifactPath } from './progress.mjs';

// oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function runtimeCli(command, args) {
  if (command === 'benchmark') {
    const { benchmarkCli } = await import('./benchmark-cli.mjs');
    const result = await benchmarkCli(args);
    console.log(result.output);
    process.exitCode = result.exitCode;
    return;
  }
  // Audit only reads saved state. Keep it before credentials, project config,
  // provider checks and engine startup (including lease/worktree handling).
  if (command === 'audit') {
    if (
      args.length < 1 ||
      args.length > 2 ||
      typeof args[0] !== 'string' ||
      !args[0].trim() ||
      args[0].startsWith('-') ||
      (args.length === 2 && args[1] !== '--json')
    ) {
      throw new Error('Использование: kodo audit RUN_ID [--json]');
    }
    const filename = path.join(stateHome(), 'state.sqlite');
    if (!existsSync(filename)) throw new Error(`Хранилище состояния отсутствует: ${filename}`);
    // Store initializes schema and journal mode, so audit opens SQLite directly.
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const row = db.prepare('SELECT body FROM runs WHERE id=?').get(args[0]);
      if (!row) throw new Error(`Запуск не найден: ${args[0]}`);
      const report = buildAuditReport(JSON.parse(row.body));
      console.log(args[1] === '--json' ? JSON.stringify(report) : formatAuditReport(report));
    } finally {
      db.close();
    }
    return;
  }
  const options = { positional: [] };
  const flags = new Set(['--json', '--live', '--prepare', '--retry-failed']);
  const values = new Set([
    '--project',
    '--client',
    '--model',
    '--mode',
    '--concurrency',
    '--providers',
    '--plan',
    '--delivery',
    '--target',
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.has(arg)) {
      if (options[arg.slice(2)] !== undefined) throw new Error(`Повторный параметр ${arg}`);
      options[arg.slice(2)] = true;
    } else if (values.has(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Требуется значение ${arg}`);
      if (options[arg.slice(2)]) throw new Error(`Повторный параметр ${arg}`);
      options[arg.slice(2)] = args[++index];
    } else if (arg.startsWith('-')) throw new Error(`Неизвестный параметр ${arg}`);
    else options.positional.push(arg);
  }
  const allowed = {
    init: ['json', 'project', 'target', 'client'],
    doctor: ['json', 'live', 'project', 'client'],
    run: ['json', 'prepare', 'project', 'client', 'model', 'mode', 'concurrency', 'providers', 'plan', 'delivery'],
    resume: ['json', 'plan', 'retry-failed'],
    status: ['json'],
    logs: ['json'],
    cancel: ['json'],
    migrate: ['json', 'target'],
    tools: ['json', 'project', 'live'],
    ui: ['json', 'project'],
    security: ['json', 'project'],
  }[command];
  if (!allowed) throw new Error(`Неизвестная команда ${command}`);
  for (const key of Object.keys(options))
    if (key !== 'positional' && !allowed?.includes(key)) throw new Error(`Параметр ${key} неприменим к ${command}`);
  if (options.mode !== undefined) {
    const { normalizeMode } = await import('./modes.mjs');
    normalizeMode(options.mode);
  }
  if (options.concurrency !== undefined) {
    if (!/^[1-5]$/.test(options.concurrency))
      throw new TypeError('Invalid concurrency: expected an integer from 1 to 5');
    options.concurrency = normalizeConcurrency(Number(options.concurrency));
  }
  const print = value => console.log(JSON.stringify(value, null, options.json ? 0 : 2));
  const project = path.resolve(options.project || options.target || process.cwd());
  // Metadata and tool setup never open the provider credential store or engine.
  if (command === 'tools') {
    const [action, id, ...extra] = options.positional;
    if (
      !['list', 'doctor', 'install'].includes(action) ||
      extra.length ||
      (action !== 'install' && id !== undefined) ||
      (action === 'install' && !id) ||
      (options.live && action !== 'doctor') ||
      (options.project && action === 'list')
    )
      throw new Error(
        'Использование: kodo tools list [--json] | doctor [--live] [--project PATH] [--json] | install <id|all> [--project PATH] [--json]',
      );
    if (action === 'list') {
      print(toolCatalog);
      return;
    }
    if (action === 'doctor') {
      const checks = await doctorTools({ project, live: Boolean(options.live) });
      print(checks);
      if (checks.some(check => !check.ready)) process.exitCode = 2;
      return;
    }
    if (id !== 'all' && !toolCatalog.some(tool => tool.id === id)) throw new Error(`Неизвестный инструмент ${id}`);
    const result = await installTools(id === 'all' ? toolCatalog.map(tool => tool.id) : [id], { project });
    print(result);
    if (result.some(check => !check.ready)) process.exitCode = 2;
    return;
  }
  if (command === 'ui' || command === 'security') {
    if (options.positional.length !== 1 || options.positional[0] !== 'verify')
      throw new Error(`Использование: kodo ${command} verify [--project PATH] [--json]`);
    const cwd = await git(project, ['rev-parse', '--show-toplevel']),
      headSha = await git(cwd, ['rev-parse', 'HEAD']);
    const clean = async () => {
      if ((await git(cwd, ['rev-parse', 'HEAD'])) !== headSha || (await git(cwd, ['status', '--porcelain'])))
        throw new Error('Verification requires a clean unchanged Git head');
    };
    await clean();
    const config = await readConfig(cwd),
      ui = command === 'ui',
      selected = ui ? config.uiVerification : config.security;
    const secrets =
      ui && selected.enabled && selected.cases.some(c => ['browser-use', 'vibetest', 'jev-ultrafast'].includes(c.tool))
        ? await loadSecrets()
        : {};
    let artifacts = path.join(stateHome(), 'verifications', randomUUID());
    try {
      assertPrivateArtifactPath(artifacts);
    } catch (error) {
      if (error.code !== 'artifacts_in_git') throw error;
      artifacts = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kodo-verification-'));
      assertPrivateArtifactPath(artifacts);
    }
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const controller = new AbortController(),
      abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const receipt = await (ui ? runUIVerification : runSecurityChecks)({
        cwd,
        headSha,
        config: selected,
        artifacts,
        secrets,
        signal: controller.signal,
      });
      await clean();
      const current = (ui ? isCurrentUIReceipt : isCurrentSecurityReceipt)(receipt, { headSha, config: selected });
      await writeFile(
        path.join(artifacts, `${command}-receipt.json`),
        JSON.stringify(redact(receipt, secrets), null, 2) + '\n',
        { mode: 0o600 },
      );
      print(redact(receipt, secrets));
      if (!current) process.exitCode = 2;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
    return;
  }
  if (command === 'init') {
    if (options.positional.length) throw new Error('init не принимает задачу');
    const catalog = await loadCatalog(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const installation = await planInstallation(
      catalog,
      ['skills/kodo-build-feature'],
      [options.client || 'all'],
      project,
    );
    const config = await readConfig(project);
    await applyInstallation(installation);
    let created = true;
    try {
      await initConfig(
        project,
        options.client && options.client !== 'all' && options.client !== 'opencode' ? { client: options.client } : {},
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      created = false;
    }
    print({
      project,
      configCreated: created,
      config: created ? await readConfig(project) : config,
      clients: installation.clients,
      components: installation.components,
    });
    return;
  }
  if (command === 'migrate') {
    print(await migrate(project));
    return;
  }
  const secrets = await loadSecrets();
  if (command === 'doctor') {
    if (options.positional.length) throw new Error('doctor не принимает аргументы');
    const config = await readConfig(project, options.client ? { client: options.client } : {});
    const checks = await doctorProviders({ secrets, config: { ...config, project }, live: Boolean(options.live) });
    print(redact({ checks }, secrets));
    if (checks.some(check => check.ok === false || check.available === false || check.status === 'error'))
      process.exitCode = 2;
    return;
  }
  const store = new Store(undefined, secrets);
  try {
    if (['status', 'logs', 'cancel', 'resume'].includes(command) && options.positional.length !== 1)
      throw new Error(`${command} требует один runId`);
    const id = options.positional[0];
    if (command === 'status') {
      print(store.getRun(id));
      return;
    }
    if (command === 'logs') {
      print(store.events(id));
      return;
    }
    if (command === 'cancel') {
      const run = store.getRun(id),
        saved = ['succeeded', 'cancelled'].includes(run.state)
          ? run
          : store.updateRun(id, { cancelRequested: true, state: 'cancelled' });
      writeProgress(saved, { home: saved.artifacts ? path.resolve(saved.artifacts, '../..') : store.home, secrets });
      print(saved);
      return;
    }
    const engine = await openEngine({
      store,
      secrets,
      onEvent: event => {
        if (!options.json) process.stderr.write(`${event.type}: ${JSON.stringify(event.data)}\n`);
      },
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      let run;
      if (command === 'run') {
        if (options.positional.length !== 1) throw new Error('run требует одно описание задачи в кавычках');
        run = await engine.create(id, { ...options, project });
      } else run = store.getRun(id);
      let result = await engine.run(run.id, {
        prepare: options.prepare,
        planFile: options.plan,
        signal: controller.signal,
        resumeCancelled: command === 'resume',
        retryFailed: Boolean(options['retry-failed']),
      });
      while (result.state === 'waiting_limits' && !controller.signal.aborted) {
        const parsed = Date.parse(result.error?.retryAt || '');
        const nextRetry = Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + 15 * 60 * 1000;
        store.updateRun(run.id, { nextRetryAt: new Date(nextRetry).toISOString() });
        if (!options.json) process.stderr.write(`waiting_limits: повтор ${new Date(nextRetry).toISOString()}\n`);
        while (Date.now() < nextRetry && !controller.signal.aborted && !store.getRun(run.id).cancelRequested)
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, nextRetry - Date.now())));
        result = await engine.run(run.id, {
          prepare: options.prepare,
          planFile: options.plan,
          signal: controller.signal,
        });
      }
      print(redact(result, secrets));
      if (!['succeeded', 'awaiting_plan'].includes(result.state)) process.exitCode = 2;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  } finally {
    store.close();
  }
}
