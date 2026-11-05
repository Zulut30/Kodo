import { randomUUID } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const slug = /^[a-z][a-z0-9-]{0,47}$/;
const invalid = () => { throw Object.assign(new Error('Invalid project arguments'), { code: 'project_arguments' }); };

function argumentsFor(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || !arg.trim() || !arg.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(arg))) invalid();
  const [action, ...args] = argv;
  const writes = ['create', 'resume', 'cancel', 'pause', 'reprioritize', 'approve-risk'];
  if (![...writes, 'status', 'plan'].includes(action)) invalid();
  const allowed = new Set(['--json', ...(writes.includes(action) ? ['--command-id'] : []),
    ...({ create: ['--file'], plan: ['--limit', '--dry-run'], resume: ['--retry-failed'],
      reprioritize: ['--priority'], 'approve-risk': ['--reason'] }[action] || [])]);
  const flags = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!allowed.has(arg) || Object.hasOwn(flags, arg)) invalid();
    if (['--json', '--dry-run', '--retry-failed'].includes(arg)) flags[arg] = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-')) invalid();
      flags[arg] = value;
    }
  }
  const count = action === 'create' ? 0 : ['reprioritize', 'approve-risk'].includes(action) ? 2 : 1;
  if (positional.length !== count || count && !uuid.test(positional[0]) || count === 2 && !slug.test(positional[1])) invalid();
  if (flags['--command-id'] !== undefined && !uuid.test(flags['--command-id'])) invalid();
  if (action === 'create' && !flags['--file'] || action === 'approve-risk' && !flags['--reason']) invalid();
  if (flags['--reason'] && Buffer.byteLength(flags['--reason']) > 65536) invalid();
  for (const [flag, required, min, max] of [['--limit', false, 1, 24], ['--priority', action === 'reprioritize', 0, 100]]) {
    const value = flags[flag];
    if (required && value === undefined || value !== undefined && (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < min || Number(value) > max)) invalid();
  }
  return { action, projectId: positional[0] || null, taskId: positional[1], flags, json: flags['--json'] === true };
}

function human(report) {
  const { result } = report;
  const heading = `Project: ${report.projectId ?? 'unknown'}; revision: ${report.revision ?? 'unknown'}`;
  if (result.progress) return heading + '\n' + result.progress;
  return heading + '\n' + JSON.stringify(result, null, 2);
}

/** Explicit, lazy Project composition. Only resume enters foreground Engine.run.
 * Ports belong to the coordinator/test harness, never to decoded CLI data.
 */
export async function projectCli(argv, ports = {}) {
  let options, store, ownedStore = false, report, exitCode = 0, safety, phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials, state, file or providers before strict parsing.
    phase = 'credentials';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    const contracts = await import('./project-contracts.mjs');
    safety = value => contracts.assertDirectorSafe(value, { knownValues: Object.values(secrets).filter(value => typeof value === 'string') });
    phase = 'input';
    safety(argv);
    let spec;
    if (options.action === 'create') {
      const { readFile, realpath } = await import('node:fs/promises');
      const input = JSON.parse(await readFile(options.flags['--file'], 'utf8'));
      safety(input); // Before canonical serialization, command hash, or Store construction.
      spec = contracts.normalizeProjectSpec(input, { knownValues: Object.values(secrets).filter(value => typeof value === 'string') });
      spec.root = await realpath(spec.root);
      safety(spec);
    }
    phase = 'operation';
    const { Store } = await import('./store.mjs');
    store = ports.store || await (ports.openStore || ((home, values) => new Store(home, values)))(ports.home || security.stateHome(), secrets);
    ownedStore = !ports.store;
    const { Engine } = await import('./engine.mjs');
    const engine = await (ports.createEngine || (values => new Engine(values)))({ store, secrets });
    const { createProjectDirector, createProjectTransitionAuthorizer } = await import('./project-director.mjs');
    const { openProjectStore } = await import('./project-store.mjs');
    const repo = await openProjectStore({ store, contracts,
      authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts }) });
    const director = createProjectDirector({ repo, engine });
    const operation = { ...(options.flags['--command-id'] ? { commandId: options.flags['--command-id'] } : {}),
      ...(options.flags['--reason'] ? { reason: options.flags['--reason'] } : {}), ...(ports.signal ? { signal: ports.signal } : {}) };
    let result, projectId = options.projectId;
    if (options.action === 'create') {
      result = await repo.apply({ schemaVersion: 1, commandId: operation.commandId || randomUUID(), projectId: null,
        expectedRevision: null, actor: 'project-cli', reason: 'Create Project from explicit specification', action: { op: 'create', spec } });
      projectId = result.projectId;
    } else if (options.action === 'status') {
      const snapshot = await repo.snapshot(projectId);
      safety(snapshot);
      const { buildProjectProgress } = await import('./project-progress.mjs');
      result = { status: snapshot.project.status, paused: snapshot.project.paused, completeness: snapshot.completeness,
        progress: buildProjectProgress(snapshot) };
      report = { schemaVersion: 1, projectId, revision: snapshot.revision, result };
    } else if (options.action === 'plan') {
      result = await director.plan(projectId, { ...(options.flags['--limit'] ? { limit: Number(options.flags['--limit']) } : {}) });
      report = { schemaVersion: 1, projectId, revision: result.revision, result };
      if (!result.taskIds.length) exitCode = 2;
    } else if (options.action === 'reprioritize') {
      result = await director.reprioritize(projectId, options.taskId, { ...operation, priority: Number(options.flags['--priority']) });
    } else if (options.action === 'approve-risk') {
      result = await director.approveRisk(projectId, options.taskId, operation);
    } else if (options.action === 'resume') {
      result = await director.resume(projectId, { ...operation, retryFailed: options.flags['--retry-failed'] === true });
      if (result.status !== 'succeeded') exitCode = 2;
    } else result = await director[options.action](projectId, operation);
    report ||= { schemaVersion: 1, projectId, revision: (await repo.snapshot(projectId)).revision, result };
    safety(report); // Guard decoded keys/values again before either output format.
  } catch (error) {
    const argumentError = phase === 'arguments';
    const dataError = ['project_schema', 'project_unsafe', 'project_limit', 'project_task_too_large',
      'project_entity_not_found', 'project_task_missing', 'project_command_conflict'].includes(error?.code);
    exitCode = argumentError || phase === 'input' || dataError ? 1 : 2;
    // Constant diagnostics only. Never echo paths, arguments, provider output or matching secrets.
    report = { schemaVersion: 1, projectId: null, revision: null,
      result: { status: exitCode === 1 ? 'invalid' : 'blocked', code: argumentError ? 'project_arguments' : exitCode === 1 ? 'project_invalid' : 'project_blocked' } };
  } finally { if (ownedStore) store?.close(); }
  return { report, exitCode, output: (options?.json || Array.isArray(argv) && argv.includes('--json'))
    ? JSON.stringify(report, null, 2) : human(report) };
}
