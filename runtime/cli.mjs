import path from 'node:path';
import { readConfig, initConfig } from './config.mjs';
import { loadSecrets, redact } from './security.mjs';
import { Store } from './store.mjs';
import { doctorProviders } from './providers.mjs';
import { openEngine } from './engine.mjs';
import { migrate } from './migration.mjs';

export async function runtimeCli(command, args) {
  const options = { positional: [] };
  const flags = new Set(['--json', '--live', '--prepare']);
  const values = new Set(['--project', '--client', '--model', '--providers', '--plan', '--delivery', '--target']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.has(arg)) options[arg.slice(2)] = true;
    else if (values.has(arg)) { if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Требуется значение ${arg}`); if (options[arg.slice(2)]) throw new Error(`Повторный параметр ${arg}`); options[arg.slice(2)] = args[++index]; }
    else if (arg.startsWith('-')) throw new Error(`Неизвестный параметр ${arg}`);
    else options.positional.push(arg);
  }
  const allowed = {
    init: ['json','project','target'], doctor: ['json','live','project','client'], run: ['json','prepare','project','client','model','providers','plan','delivery'],
    resume: ['json','plan'], status: ['json'], logs: ['json'], cancel: ['json'], migrate: ['json','target']
  }[command];
  for (const key of Object.keys(options)) if (key !== 'positional' && !allowed?.includes(key)) throw new Error(`Параметр ${key} неприменим к ${command}`);
  const print = value => console.log(JSON.stringify(value, null, options.json ? 0 : 2));
  const project = path.resolve(options.project || options.target || process.cwd());
  if (command === 'init') { if (options.positional.length) throw new Error('init не принимает задачу'); print(await initConfig(project)); return; }
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
      const result = await engine.run(run.id, { prepare: options.prepare, planFile: options.plan, signal: controller.signal });
      print(redact(result, secrets)); if (!['succeeded', 'awaiting_plan'].includes(result.state)) process.exitCode = 2;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } finally { store.close(); }
}
