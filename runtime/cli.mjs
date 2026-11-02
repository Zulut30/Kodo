import path from 'node:path';
import { readConfig, initConfig } from './config.mjs';
import { loadSecrets, redact } from './security.mjs';
import { Store } from './store.mjs';
import { doctorProviders } from './providers.mjs';
import { openEngine } from './engine.mjs';
import { migrate } from './migration.mjs';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../cli/catalog.mjs';
import { planInstallation, applyInstallation } from '../cli/installer.mjs';

export async function runtimeCli(command, args) {
  const options = { positional: [] };
  const flags = new Set(['--json', '--live', '--prepare', '--retry-failed']);
  const values = new Set(['--project', '--client', '--model', '--providers', '--plan', '--delivery', '--target']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.has(arg)) options[arg.slice(2)] = true;
    else if (values.has(arg)) { if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Требуется значение ${arg}`); if (options[arg.slice(2)]) throw new Error(`Повторный параметр ${arg}`); options[arg.slice(2)] = args[++index]; }
    else if (arg.startsWith('-')) throw new Error(`Неизвестный параметр ${arg}`);
    else options.positional.push(arg);
  }
  const allowed = {
    init: ['json','project','target','client'], doctor: ['json','live','project','client'], run: ['json','prepare','project','client','model','providers','plan','delivery'],
    resume: ['json','plan','retry-failed'], status: ['json'], logs: ['json'], cancel: ['json'], migrate: ['json','target']
  }[command];
  for (const key of Object.keys(options)) if (key !== 'positional' && !allowed?.includes(key)) throw new Error(`Параметр ${key} неприменим к ${command}`);
  const print = value => console.log(JSON.stringify(value, null, options.json ? 0 : 2));
  const project = path.resolve(options.project || options.target || process.cwd());
  if (command === 'init') {
    if (options.positional.length) throw new Error('init не принимает задачу');
    const catalog = await loadCatalog(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const installation = await planInstallation(catalog, ['skills/kodo-build-feature'], [options.client || 'all'], project);
    const config = await readConfig(project);
    await applyInstallation(installation);
    let created = true;
    try { await initConfig(project, options.client && options.client !== 'all' && options.client !== 'opencode' ? { client: options.client } : {}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; created = false; }
    print({ project, configCreated: created, config: created ? await readConfig(project) : config, clients: installation.clients, components: installation.components }); return;
  }
  if (command === 'migrate') { print(await migrate(project)); return; }
  const secrets = await loadSecrets();
  if (command === 'doctor') {
    if (options.positional.length) throw new Error('doctor не принимает аргументы');
    const config = await readConfig(project, options.client ? { client: options.client } : {});
    const checks = await doctorProviders({ secrets, config: { ...config, project }, live: Boolean(options.live) });
    print(redact({ checks }, secrets)); if (checks.some(check => check.ok === false || check.available === false || check.status === 'error')) process.exitCode = 2; return;
  }
  const store = new Store(undefined, secrets);
  try {
    if (['status', 'logs', 'cancel', 'resume'].includes(command) && options.positional.length !== 1) throw new Error(`${command} требует один runId`);
    const id = options.positional[0];
    if (command === 'status') { print(store.getRun(id)); return; }
    if (command === 'logs') { print(store.events(id)); return; }
    if (command === 'cancel') { const run = store.getRun(id); print(['succeeded','cancelled'].includes(run.state) ? run : store.updateRun(id, { cancelRequested: true, state: 'cancelled' })); return; }
    const engine = await openEngine({ store, secrets, onEvent: event => { if (!options.json) process.stderr.write(`${event.type}: ${JSON.stringify(event.data)}\n`); } });
    const controller = new AbortController(); const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      let run;
      if (command === 'run') { if (options.positional.length !== 1) throw new Error('run требует одно описание задачи в кавычках'); run = await engine.create(id, { ...options, project }); }
      else run = store.getRun(id);
      let result = await engine.run(run.id, { prepare: options.prepare, planFile: options.plan, signal: controller.signal, resumeCancelled: command === 'resume', retryFailed: Boolean(options['retry-failed']) });
      while (result.state === 'waiting_limits' && !controller.signal.aborted) {
        const parsed = Date.parse(result.error?.retryAt || '');
        const nextRetry = Number.isFinite(parsed) && parsed > Date.now() ? parsed : Date.now() + 15 * 60 * 1000;
        store.updateRun(run.id, { nextRetryAt: new Date(nextRetry).toISOString() });
        if (!options.json) process.stderr.write(`waiting_limits: повтор ${new Date(nextRetry).toISOString()}\n`);
        while (Date.now() < nextRetry && !controller.signal.aborted && !store.getRun(run.id).cancelRequested) await new Promise(resolve => setTimeout(resolve, Math.min(1000, nextRetry - Date.now())));
        result = await engine.run(run.id, { signal: controller.signal });
      }
      print(redact(result, secrets)); if (!['succeeded', 'awaiting_plan'].includes(result.state)) process.exitCode = 2;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } finally { store.close(); }
}
