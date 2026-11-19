// `kodo project drain PROJECT_ID [--max-waves 1..100] [--concurrency 1..5] [--retry-failed]
// [--command-id UUID] [--json]`: strict parsing before credentials or state, the same
// composition, report and exit codes as project-cli (0 done, 1 invalid input, 2 blocked).
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invalid = () => {
  throw Object.assign(new Error('Invalid project arguments'), { code: 'project_arguments' });
};
const bounded = (value, min, max) =>
  value === undefined || (/^(0|[1-9][0-9]*)$/.test(value) && Number(value) >= min && Number(value) <= max);

function argumentsFor(argv) {
  if (
    !Array.isArray(argv) ||
    argv.some(
      arg =>
        typeof arg !== 'string' || !arg.trim() || !arg.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(arg),
    ) ||
    argv[0] !== 'drain'
  )
    invalid();
  const allowed = new Set(['--json', '--retry-failed', '--command-id', '--max-waves', '--concurrency']);
  const flags = {},
    positional = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!allowed.has(arg) || Object.hasOwn(flags, arg)) invalid();
    if (['--json', '--retry-failed'].includes(arg)) flags[arg] = true;
    else {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('-')) invalid();
      flags[arg] = value;
    }
  }
  if (positional.length !== 1 || !uuid.test(positional[0])) invalid();
  if (flags['--command-id'] !== undefined && !uuid.test(flags['--command-id'])) invalid();
  if (!bounded(flags['--max-waves'], 1, 100) || !bounded(flags['--concurrency'], 1, 5)) invalid();
  return { projectId: positional[0], flags, json: flags['--json'] === true };
}

function human(report) {
  return (
    `Project: ${report.projectId ?? 'unknown'}; revision: ${report.revision ?? 'unknown'}\n` +
    JSON.stringify(report.result, null, 2)
  );
}

/** Wave drain through the explicit Project composition. Ports belong to the coordinator/tests. */
export async function projectWaveCli(argv, ports = {}) {
  let options,
    store,
    ownedStore = false,
    report,
    exitCode = 0,
    phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials, state or providers before strict parsing.
    phase = 'credentials';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    const contracts = await import('./project-contracts.mjs');
    const knownValues = Object.values(secrets).filter(value => typeof value === 'string');
    const safety = value => contracts.assertDirectorSafe(value, { knownValues });
    phase = 'input';
    safety(argv);
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
    const director = createProjectDirector(/** @type {any} */ ({ repo, engine }));
    const result = await director.drain(options.projectId, {
      ...(options.flags['--max-waves'] ? { maxWaves: Number(options.flags['--max-waves']) } : {}),
      ...(options.flags['--concurrency'] ? { concurrency: Number(options.flags['--concurrency']) } : {}),
      retryFailed: options.flags['--retry-failed'] === true,
      ...(options.flags['--command-id'] ? { commandId: options.flags['--command-id'] } : {}),
      ...(ports.signal ? { signal: ports.signal } : {}),
    });
    // A bounded drain that stopped at its wave limit did what was asked.
    if (!['accepted', 'max_waves'].includes(result.status)) exitCode = 2;
    report = { schemaVersion: 1, projectId: options.projectId, revision: result.revision, result };
    safety(report);
  } catch (error) {
    const argumentError = phase === 'arguments';
    const dataError = [
      'project_schema',
      'project_unsafe',
      'project_entity_not_found',
      'project_drain_invalid',
    ].includes(error?.code);
    exitCode = argumentError || phase === 'input' || dataError ? 1 : 2;
    // Constant diagnostics only. Never echo paths, arguments, provider output or matching secrets.
    report = {
      schemaVersion: 1,
      projectId: null,
      revision: null,
      result: {
        status: exitCode === 1 ? 'invalid' : 'blocked',
        code: argumentError ? 'project_arguments' : exitCode === 1 ? 'project_invalid' : 'project_blocked',
      },
    };
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
