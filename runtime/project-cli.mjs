import { randomUUID } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const slug = /^[a-z][a-z0-9-]{0,47}$/;
const invalid = () => {
  throw Object.assign(new Error('Invalid project arguments'), { code: 'project_arguments' });
};

function validateFlags(action, flags, positional) {
  const count = action === 'create' ? 0 : ['reprioritize', 'approve-risk'].includes(action) ? 2 : 1;
  if (positional.length !== count || (count && !uuid.test(positional[0])) || (count === 2 && !slug.test(positional[1])))
    invalid();
  if (flags['--command-id'] !== undefined && !uuid.test(flags['--command-id'])) invalid();
  if (
    (['create', 'set'].includes(action) && !flags['--file']) ||
    (action === 'pause-pool' && (!flags['--subscription'] || !flags['--until'])) ||
    (action === 'approve-risk' && !flags['--reason'])
  )
    invalid();
  if (flags['--reason'] && Buffer.byteLength(flags['--reason']) > 65536) invalid();
}

function argumentsFor(argv) {
  if (
    !Array.isArray(argv) ||
    argv.some(
      arg =>
        typeof arg !== 'string' || !arg.trim() || !arg.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(arg),
    )
  )
    invalid();
  let [action, ...args] = argv;
  const profile = action === 'profile';
  if (profile) [action, ...args] = args;
  if (profile && !['set', 'show', 'pause-pool'].includes(action)) invalid();
  const writes = ['create', 'resume', 'cancel', 'pause', 'reprioritize', 'approve-risk'];
  if (!profile && ![...writes, 'status', 'plan'].includes(action)) invalid();
  const allowed = new Set([
    '--json',
    ...(writes.includes(action) ? ['--command-id'] : []),
    ...({
      create: ['--file'],
      set: ['--file'],
      'pause-pool': ['--subscription', '--until'],
      plan: ['--limit', '--dry-run'],
      resume: ['--retry-failed'],
      reprioritize: ['--priority'],
      'approve-risk': ['--reason'],
    }[action] || []),
  ]);
  const flags = {},
    positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!allowed.has(arg) || Object.hasOwn(flags, arg)) invalid();
    if (['--json', '--dry-run', '--retry-failed'].includes(arg)) flags[arg] = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-')) invalid();
      flags[arg] = value;
    }
  }
  validateFlags(action, flags, positional);
  for (const [flag, required, min, max] of [
    ['--limit', false, 1, 24],
    ['--priority', action === 'reprioritize', 0, 100],
  ]) {
    const value = flags[flag];
    if (
      (required && value === undefined) ||
      (value !== undefined && (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < min || Number(value) > max))
    )
      invalid();
  }
  return { action, projectId: positional[0] || null, taskId: positional[1], flags, json: flags['--json'] === true };
}

/**
 * The blockers of `kodo report --project` (telemetry): task and attempt blockers of the current
 * attempts' Runs and, in a wave project, gate Runs that stopped without acceptance.
 */
async function statusBlockers(store, snapshot) {
  const { storedRun } = await import('./project-director.mjs');
  const { buildProjectReport } = await import('./telemetry.mjs');
  const runs = new Map();
  for (const { runId } of [...snapshot.currentAttempts, ...(snapshot.gates ?? [])]) {
    const run = typeof runId === 'string' && !runs.has(runId) ? storedRun(store, runId) : null;
    if (run) runs.set(runId, run);
  }
  return buildProjectReport(snapshot, runs, {}).blockers;
}

function human(report) {
  const { result } = report;
  const heading = `Project: ${report.projectId ?? 'unknown'}; revision: ${report.revision ?? 'unknown'}`;
  if (result.progress) return heading + '\n' + result.progress;
  return heading + '\n' + JSON.stringify(result, null, 2);
}

// Wave and blueprint commands keep their own strict parsers: drain, the pull protocol of
// external chats, and the project factory (bootstrap, apply-spec, extend, append-milestone).
const blueprintActions = new Set(['bootstrap', 'apply-spec', 'extend', 'append-milestone']);
/** Read-only alias: `project report PROJECT_ID [--json]` is `report --project PROJECT_ID [--json]`. */
async function reportAlias(argv, ports) {
  const { reportCli } = await import('./report-cli.mjs');
  const rest = argv.slice(1),
    at = rest.findIndex(arg => typeof arg === 'string' && !arg.startsWith('-'));
  return reportCli(at < 0 ? rest : [...rest.slice(0, at), '--project', ...rest.slice(at)], ports);
}

async function waveCommand(argv) {
  const action = Array.isArray(argv) ? argv[0] : undefined;
  if (action === 'report') return reportAlias;
  if (action === 'drain') return (await import('./project-cli-wave.mjs')).projectWaveCli;
  if (action === 'next-wave' || action === 'complete-task' || action === 'gates')
    return (await import('./project-cli-external.mjs')).projectExternalCli;
  if (blueprintActions.has(action)) return (await import('./project-cli-blueprint.mjs')).projectBlueprintCli;
  return null;
}

async function readProjectInput(options, contracts, secrets, safety) {
  if (!['create', 'set'].includes(options.action)) return null;
  const { readFile, realpath } = await import('node:fs/promises');
  const input = JSON.parse(await readFile(options.flags['--file'], 'utf8'));
  safety(input);
  const knownValues = Object.values(secrets).filter(v => typeof v === 'string');
  if (options.action === 'set') {
    const { validateExecutionProfile } = await import('./execution-profile.mjs');
    return validateExecutionProfile(input, { knownValues });
  }
  const spec = contracts.normalizeProjectSpec(input, { knownValues });
  spec.root = await realpath(spec.root);
  safety(spec);
  return spec;
}

function profileOperation(store, repo, { action, projectId, flags }, input) {
  if (action === 'show') return repo.getProfile(projectId);
  const lease = store.acquireLease('project-profile:' + projectId, randomUUID(), { ttlMs: 60000, limit: 1 });
  if (!lease) throw Object.assign(new Error('Project busy'), { code: 'project_busy' });
  try {
    return action === 'set'
      ? repo.setProfile(projectId, input)
      : repo.pausePool(projectId, flags['--subscription'], flags['--until']);
  } finally {
    store.releaseLease(lease);
  }
}

function projectFailure(error, phase, action) {
  const profile = ['set', 'show', 'pause-pool'].includes(action);
  const argumentError = phase === 'arguments';
  const dataError = [
    ...(profile ? ['project_profile_invalid', 'project_wave_required'] : []),
    'project_schema',
    'project_unsafe',
    'project_limit',
    'project_task_too_large',
    'project_entity_not_found',
    'project_task_missing',
    'project_command_conflict',
  ].includes(error?.code);
  const exitCode = argumentError || phase === 'input' || dataError ? 1 : 2;
  // Constant diagnostics only. Never echo paths, arguments, provider output or matching secrets.
  const report = {
    schemaVersion: 1,
    projectId: null,
    revision: null,
    result: {
      status: exitCode === 1 ? 'invalid' : 'blocked',
      code:
        profile &&
        [
          'project_busy',
          'project_profile_invalid',
          'project_wave_required',
          'project_database_corrupt',
          'project_unsafe',
        ].includes(error?.code)
          ? error.code
          : argumentError
            ? 'project_arguments'
            : exitCode === 1
              ? 'project_invalid'
              : 'project_blocked',
    },
  };
  return { report, exitCode };
}

/** Explicit, lazy Project composition. Only resume enters foreground Engine.run.
 * Ports belong to the coordinator/test harness, never to decoded CLI data.
 */
export async function projectCli(argv, ports = {}) {
  // Help precedes strict parsing, credentials and state of every project action.
  const help = (await import('./project-help.mjs')).projectHelp(argv);
  if (help) return help;
  const wave = await waveCommand(argv);
  if (wave) return wave(argv, ports);
  let options,
    store,
    ownedStore = false,
    report,
    exitCode = 0,
    safety,
    phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials, state, file or providers before strict parsing.
    phase = 'credentials';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    const contracts = await import('./project-contracts.mjs');
    safety = value =>
      contracts.assertDirectorSafe(value, {
        knownValues: Object.values(secrets).filter(value => typeof value === 'string'),
      });
    phase = 'input';
    safety(argv);
    const input = await readProjectInput(options, contracts, secrets, safety);
    phase = 'operation';
    const { Store } = await import('./store.mjs');
    store =
      ports.store ||
      (await (ports.openStore || ((home, values) => new Store(home, values)))(
        ports.home || security.stateHome(),
        secrets,
      ));
    ownedStore = !ports.store;
    const { Engine } = await import('./engine.mjs');
    const engine = await (ports.createEngine || (values => new Engine(values)))({ store, secrets });
    const { createProjectDirector, createProjectTransitionAuthorizer } = await import('./project-director.mjs');
    const { openProjectStore } = await import('./project-store.mjs');
    const repo = await openProjectStore({
      store,
      contracts,
      authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts }),
    });
    const director = createProjectDirector({ repo, engine });
    const operation = {
      ...(options.flags['--command-id'] ? { commandId: options.flags['--command-id'] } : {}),
      ...(options.flags['--reason'] ? { reason: options.flags['--reason'] } : {}),
      ...(ports.signal ? { signal: ports.signal } : {}),
    };
    let result,
      projectId = options.projectId;
    if (options.action === 'create') {
      result = await repo.apply({
        schemaVersion: 1,
        commandId: operation.commandId || randomUUID(),
        projectId: null,
        expectedRevision: null,
        actor: 'project-cli',
        reason: 'Create Project from explicit specification',
        action: { op: 'create', spec: input },
      });
      projectId = result.projectId;
    } else if (['set', 'show', 'pause-pool'].includes(options.action)) {
      result = { profile: profileOperation(store, repo, options, input) };
    } else if (options.action === 'status') {
      const snapshot = await repo.snapshot(projectId);
      safety(snapshot);
      const { buildProjectProgress } = await import('./project-progress.mjs');
      const blockers = await statusBlockers(store, snapshot);
      result = {
        status: snapshot.project.status,
        paused: snapshot.project.paused,
        completeness: snapshot.completeness,
        blockers,
        progress: buildProjectProgress(snapshot, blockers),
      };
      report = { schemaVersion: 1, projectId, revision: snapshot.revision, result };
    } else if (options.action === 'plan') {
      result = await director.plan(projectId, {
        ...(options.flags['--limit'] && { limit: Number(options.flags['--limit']) }),
      });
      report = { schemaVersion: 1, projectId, revision: result.revision, result };
      if (!result.taskIds.length) exitCode = 2;
    } else if (options.action === 'reprioritize') {
      result = await director.reprioritize(projectId, options.taskId, {
        ...operation,
        priority: Number(options.flags['--priority']),
      });
    } else if (options.action === 'approve-risk') {
      result = await director.approveRisk(projectId, options.taskId, operation);
    } else if (options.action === 'resume') {
      result = await director.resume(projectId, {
        ...operation,
        retryFailed: options.flags['--retry-failed'] === true,
      });
      if (result.status !== 'succeeded') exitCode = 2;
    } else result = await director[options.action](projectId, operation);
    report ||= { schemaVersion: 1, projectId, revision: (await repo.snapshot(projectId)).revision, result };
    safety(report); // Guard decoded keys/values again before either output format.
  } catch (error) {
    ({ exitCode, report } = projectFailure(error, phase, options?.action));
  } finally {
    if (ownedStore) store?.close();
  }
  return {
    report,
    exitCode,
    output:
      options?.json || (Array.isArray(argv) && argv.includes('--json'))
        ? JSON.stringify(report, null, 2)
        : human(report),
  };
}
