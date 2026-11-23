import { isPullHost } from './job-contracts.mjs';
import { PATH_UNSAFE_MESSAGE, assertCliPrefix } from './cli-command.mjs';

// `kodo project next-wave|complete-task|gates`: the pull protocol of external worker
// chats (docs/T3-HOST.md). Strict parsing precedes credentials, state and Git.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const slug = /^[a-z][a-z0-9-]{0,47}$/;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const booleans = ['--json', '--retry-failed', '--defer-gate', '--abandon'];
const flagsFor = {
  'next-wave': ['--json', '--host', '--limit', '--retry-failed'],
  'complete-task': ['--json', '--head', '--defer-gate', '--abandon', '--command-id', '--attempt'],
  gates: ['--json', '--retry-failed'],
};
// Constant codes of the protocol itself; never data, paths or provider output.
const reported = new Set([
  'project_wave_required',
  'project_host_unsupported',
  'project_limit_invalid',
  'project_head_invalid',
  'project_busy',
  'project_control_blocked',
  'project_task_missing',
  'project_attempt_missing',
  'project_attempt_not_external',
  'project_wave_ports_invalid',
  'project_snapshot_incomplete',
  'project_cli_invalid',
  'project_path_unsafe',
]);
const dataErrors = new Set([
  'project_schema',
  'project_unsafe',
  'project_limit',
  'project_entity_not_found',
  'project_task_missing',
  'project_command_conflict',
  'project_wave_required',
  'project_attempt_missing',
  'project_attempt_not_external',
  'project_cli_invalid',
  'project_path_unsafe',
]);
const invalid = () => {
  throw Object.assign(new Error('Invalid project arguments'), { code: 'project_arguments' });
};

function argumentsFor(argv) {
  if (
    !Array.isArray(argv) ||
    argv.some(
      arg =>
        typeof arg !== 'string' || !arg.trim() || !arg.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(arg),
    )
  )
    invalid();
  const [action, ...args] = argv;
  if (!Object.hasOwn(flagsFor, action)) invalid();
  const flags = {},
    positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!flagsFor[action].includes(arg) || Object.hasOwn(flags, arg)) invalid();
    if (booleans.includes(arg)) flags[arg] = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-')) invalid();
      flags[arg] = value;
    }
  }
  const next = action === 'next-wave',
    complete = action === 'complete-task';
  if (positional.length !== (complete ? 2 : 1) || !uuid.test(positional[0]) || (complete && !slug.test(positional[1])))
    invalid();
  if (next && (!isPullHost(flags['--host']) || (flags['--limit'] !== undefined && !/^[1-5]$/.test(flags['--limit']))))
    invalid();
  if (complete && (!sha.test(flags['--head'] ?? '') || (flags['--defer-gate'] && flags['--abandon']))) invalid();
  if (flags['--command-id'] !== undefined && !uuid.test(flags['--command-id'])) invalid();
  if (flags['--attempt'] !== undefined && !uuid.test(flags['--attempt'])) invalid();
  // An abandon names the attempt it stops: a late repeat can never stop a newer attempt.
  if (flags['--abandon'] && flags['--attempt'] === undefined) invalid();
  return { action, projectId: positional[0], taskId: positional[1], flags, json: flags['--json'] === true };
}

function human(report) {
  const { result } = report;
  const lines = [`Project: ${report.projectId ?? 'unknown'}; revision: ${report.revision ?? 'unknown'}`];
  if (!Array.isArray(result.briefs)) return lines.concat(JSON.stringify(result, null, 2)).join('\n');
  for (const brief of result.briefs)
    lines.push(
      `- ${brief.chatTitle} (${brief.role})`,
      `  worktree: ${brief.worktree}`,
      `  branch: ${brief.branch}`,
      `  self-check: ${brief.selfCheck}`,
      `  complete: ${brief.completeCommand}`,
    );
  for (const row of result.blocked) lines.push(`- blocked ${row.taskId ?? `${row.kind} ${row.id}`}: ${row.code}`);
  if (result.code) lines.push(`Project: ${result.code}`);
  else if (!result.briefs.length && !result.blocked.length) lines.push('No task is ready for this host.');
  return lines.join('\n');
}

async function operate(options, ports, safety) {
  const security = await import('./security.mjs');
  const { Store } = await import('./store.mjs');
  const store =
    ports.store ||
    (await (ports.openStore || ((home, values) => new Store(home, values)))(
      ports.home || security.stateHome(),
      ports.secrets,
    ));
  try {
    const { Engine } = await import('./engine.mjs');
    const engine = await (ports.createEngine || (values => new Engine(values)))({ store, secrets: ports.secrets });
    const contracts = await import('./project-contracts.mjs');
    const external = await import('./project-external.mjs');
    const { openProjectStore } = await import('./project-store.mjs');
    // The one production authorizer: wave projects take its wave branch (validateWaveRun).
    const authorizer =
      ports.createAuthorizer || (await import('./project-director.mjs')).createProjectTransitionAuthorizer;
    const repo = await openProjectStore({
      store,
      contracts,
      authorizeTransition: authorizer({ store, engine, contracts }),
    });
    const ctx = { repo, engine, store, contracts },
      { flags } = options;
    let result, success;
    if (options.action === 'next-wave') {
      result = await external.nextWave(ctx, {
        projectId: options.projectId,
        host: flags['--host'],
        limit: flags['--limit'] === undefined ? 3 : Number(flags['--limit']),
        retryFailed: flags['--retry-failed'] === true,
        ports: ports.wave,
        // The CLI entry passes its own command: the briefs call the same Kodo package.
        ...(ports.cli === undefined ? {} : { cli: ports.cli }),
      });
      success = result.briefs.length > 0;
    } else if (options.action === 'gates') {
      result = await external.runProjectGates(ctx, {
        projectId: options.projectId,
        retryFailed: flags['--retry-failed'] === true,
        ports: ports.wave,
        ...(ports.signal ? { signal: ports.signal } : {}),
      });
      success = result.status === 'passed';
    } else {
      result = await external.completeTask(ctx, {
        projectId: options.projectId,
        taskId: options.taskId,
        head: flags['--head'],
        deferGate: flags['--defer-gate'] === true,
        abandon: flags['--abandon'] === true,
        ...(flags['--command-id'] ? { commandId: flags['--command-id'] } : {}),
        ...(flags['--attempt'] ? { attemptId: flags['--attempt'] } : {}),
        ports: ports.wave,
        ...(ports.signal ? { signal: ports.signal } : {}),
      });
      success = ['integrated', 'abandoned'].includes(result.status);
    }
    const report = { schemaVersion: 1, projectId: options.projectId, revision: result.revision, result };
    safety(report); // Guard decoded keys/values again before either output format.
    return { report, exitCode: success ? 0 : 2 };
  } finally {
    if (!ports.store) store.close();
  }
}

/**
 * Ports belong to the coordinator/test harness, never to decoded CLI data:
 * `secrets`/`loadSecrets`, `store`/`openStore`/`home`, `createEngine`,
 * `createAuthorizer`, `wave` (the director's wave functions), `cli` (command prefix of
 * the brief commands, runtime/cli-command.mjs) and `signal`.
 */
export async function projectExternalCli(argv, ports = {}) {
  let options,
    outcome,
    phase = 'arguments';
  try {
    options = argumentsFor(argv); // No credentials, state, Git or providers before strict parsing.
    phase = 'credentials';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    const contracts = await import('./project-contracts.mjs');
    const knownValues = Object.values(secrets).filter(value => typeof value === 'string');
    const safety = value => contracts.assertDirectorSafe(value, { knownValues });
    phase = 'input';
    safety(argv);
    // The prefix of next-wave's brief commands: checked before the Store opens or anything is written.
    if (options.action === 'next-wave' && ports.cli !== undefined) safety(assertCliPrefix(ports.cli));
    phase = 'operation';
    outcome = await operate(options, { ...ports, secrets }, safety);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : '';
    const exitCode = phase === 'arguments' || phase === 'input' || dataErrors.has(code) ? 1 : 2;
    // Constant diagnostics only. Never echo paths, arguments, provider output or matching secrets.
    outcome = {
      exitCode,
      report: {
        schemaVersion: 1,
        projectId: null,
        revision: null,
        result: {
          status: exitCode === 1 ? 'invalid' : 'blocked',
          code:
            phase === 'arguments'
              ? 'project_arguments'
              : reported.has(code)
                ? code
                : exitCode === 1
                  ? 'project_invalid'
                  : 'project_blocked',
          ...(code === 'project_path_unsafe' ? { message: PATH_UNSAFE_MESSAGE } : {}),
        },
      },
    };
  }
  const json = options?.json || (Array.isArray(argv) && argv.includes('--json'));
  return { ...outcome, output: json ? JSON.stringify(outcome.report, null, 2) : human(outcome.report) };
}
