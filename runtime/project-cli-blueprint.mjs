// Project factory CLI: `kodo project bootstrap|apply-spec|extend|append-milestone`.
// Strict parsing happens before credentials, state, files or providers. Native
// generation uses one subscription session through the Engine provider; there is
// no API fallback. The report envelope matches runtime/project-cli.mjs.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_CLI, PATH_UNSAFE_MESSAGE, assertCliPrefix, quotePath } from './cli-command.mjs';

export const BLUEPRINT_ACTIONS = Object.freeze(['bootstrap', 'apply-spec', 'extend', 'append-milestone']);

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const CLIENTS = ['codex', 'claude-code'];
const MAX_IDEA = 64 * 1024;
const SAFE_CODE = /^(?:project|bootstrap|milestone|blueprint)_[a-z_]{1,48}$/;
const DATA_CODES = [
  'project_schema',
  'project_unsafe',
  'project_limit',
  'project_task_too_large',
  'project_entity_not_found',
  'project_task_missing',
  'project_command_conflict',
  'project_path_unsafe',
];
// positional: [count, kinds]; values/booleans: allowed flags; required flags.
const GRAMMAR = {
  bootstrap: { positional: ['idea'], values: ['--root', '--client', '--model'], booleans: ['--prepare'] },
  'apply-spec': { positional: [], values: ['--root', '--file', '--command-id'], booleans: [] },
  extend: {
    positional: ['project', 'idea'],
    values: ['--client', '--model', '--command-id'],
    booleans: ['--prepare'],
  },
  'append-milestone': { positional: ['project'], values: ['--file', '--command-id'], booleans: [] },
};
const REQUIRED = { bootstrap: ['--root'], 'apply-spec': ['--root'], 'append-milestone': ['--file'] };

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
  const grammar = GRAMMAR[action];
  if (!grammar) invalid();
  const flags = {},
    positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) positional.push(arg);
    else if (Object.hasOwn(flags, arg)) invalid();
    else if (arg === '--json' || grammar.booleans.includes(arg)) flags[arg] = true;
    else if (grammar.values.includes(arg)) {
      const value = args[++i];
      if (!value?.trim() || value.startsWith('-')) invalid();
      flags[arg] = value;
    } else invalid();
  }
  if (positional.length !== grammar.positional.length) invalid();
  const kinds = Object.fromEntries(grammar.positional.map((kind, index) => [kind, positional[index]]));
  if (kinds.project !== undefined && !uuid.test(kinds.project)) invalid();
  if (kinds.idea !== undefined && Buffer.byteLength(kinds.idea) > MAX_IDEA) invalid();
  if ((REQUIRED[action] || []).some(flag => flags[flag] === undefined)) invalid();
  if (flags['--command-id'] !== undefined && !uuid.test(flags['--command-id'])) invalid();
  if (flags['--client'] !== undefined && !CLIENTS.includes(flags['--client'])) invalid();
  if (flags['--model'] !== undefined && !modelName.test(flags['--model'])) invalid();
  // Preparation only writes a bundle: session and write options are meaningless there.
  if (flags['--prepare'] && ['--client', '--model', '--command-id'].some(flag => flags[flag] !== undefined)) invalid();
  return {
    action,
    projectId: kinds.project ?? null,
    idea: kinds.idea,
    prepare: flags['--prepare'] === true,
    flags,
    json: flags['--json'] === true,
  };
}

function human(report) {
  const heading = `Project: ${report.projectId ?? 'unknown'}; revision: ${report.revision ?? 'unknown'}`;
  return heading + '\n' + JSON.stringify(report.result, null, 2);
}

const envelope = (projectId, revision, result, exitCode = 0) => ({
  exitCode,
  report: { schemaVersion: 1, projectId, revision, result },
});

/** Findings keep code, task ids and Kodo's template message (no file contents
 * or absolute paths); the whole report is checked against known secrets. */
function findingsReport(findings, extra = {}, { projectId = null, revision = null } = {}) {
  const rows = findings.map(item => ({
    code: item.code,
    ...(Array.isArray(item.taskIds) ? { taskIds: item.taskIds } : {}),
    message: item.message,
  }));
  return envelope(projectId, revision, { status: 'invalid', code: 'blueprint_findings', ...extra, findings: rows }, 1);
}

/** Compact module map: milestones -> epics -> task ids; Wave 0 task ids. */
function moduleMap({ milestones, epics, tasks }) {
  const wave = new Set(
    epics.filter(epic => epic.id === 'foundation' || epic.milestoneId === 'foundation').map(epic => epic.id),
  );
  return {
    milestones: milestones.map(milestone => ({
      id: milestone.id,
      title: milestone.title,
      epics: epics
        .filter(epic => epic.milestoneId === milestone.id)
        .map(epic => ({
          id: epic.id,
          title: epic.title,
          tasks: tasks.filter(task => task.epicId === epic.id).map(task => task.id),
        })),
    })),
    waveZero: tasks.filter(task => wave.has(task.epicId)).map(task => task.id),
  };
}

async function openState(ctx) {
  if (ctx.state) return ctx.state;
  const { ports, secrets, contracts } = ctx;
  const { Store } = await import('./store.mjs');
  const store =
    ports.store || (await (ports.openStore || ((home, values) => new Store(home, values)))(ctx.home, secrets));
  ctx.state = { store, owned: !ports.store };
  const { Engine } = await import('./engine.mjs');
  const engine = await (ports.createEngine || (values => new Engine(values)))({ store, secrets });
  const { createProjectTransitionAuthorizer } = await import('./project-director.mjs');
  const { openProjectStore } = await import('./project-store.mjs');
  const repo = await openProjectStore({
    store,
    contracts,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts }),
  });
  Object.assign(ctx.state, { engine, repo });
  return ctx.state;
}

// Graph of the committed HEAD under its architecture.policy.json. Any failure
// (no Git, no policy, unsafe layout) leaves the bundle without a graph.
async function architectureGraph(root) {
  const { realpath } = await import('node:fs/promises');
  const { git } = await import('./workspace.mjs');
  const { workerEnvironment } = await import('./security.mjs');
  const { validateArchitecturePolicy } = await import('./architecture-policy.mjs');
  const { readArchitectureGraph } = await import('./architecture-graph.mjs');
  const project = await realpath(root);
  const options = { env: workerEnvironment(), timeoutMs: 10000 };
  const headSha = await git(project, ['rev-parse', '--verify', 'HEAD'], options);
  const raw = JSON.parse(await git(project, ['show', `${headSha}:architecture.policy.json`], options));
  return readArchitectureGraph({ project, headSha, policy: validateArchitecturePolicy(raw) });
}

async function knowledgeFor(ctx, root, task) {
  if (ctx.ports.knowledge !== undefined) return ctx.ports.knowledge;
  try {
    const { knowledgeSnapshot } = await import('./knowledge-cli.mjs');
    const result = await knowledgeSnapshot(
      { project: root, task, subject: undefined, ownedCwds: undefined, now: undefined },
      { secrets: ctx.secrets, home: ctx.home },
    );
    return result?.status === 'ready' ? result.evaluation : undefined;
  } catch {
    return undefined;
  }
}

async function contextInputs(ctx, root, task) {
  return {
    architecture: ctx.ports.architecture !== undefined ? ctx.ports.architecture : () => architectureGraph(root),
    knowledge: await knowledgeFor(ctx, root, task),
  };
}

async function sessionProvider(ctx) {
  const { engine } = await openState(ctx);
  return ctx.ports.provider || engine.provider;
}

// A path that a next hint quotes is checked before anything is written (a missing one is
// left to its own refusal): runtime/cli-command.mjs.
async function commandPath(value) {
  const { realpath } = await import('node:fs/promises');
  const real = await realpath(value).catch(() => null);
  if (real) quotePath(real);
}

// Wave checks run under kodo.config.json of the committed base (runtime/wave-policy.mjs): without it
// the defaults apply (client codex, commands.test npm test), whatever the stack or subscription.
const configStep = (root, template) =>
  `До apply-spec создай ${path.join(root, 'kodo.config.json')} по шаблону ${template}: client — подписочный клиент гейтов ` +
  '(codex или claude-code), commands.test — команда тестов стека (rules.md); закоммить его вместе с исходным состоянием.';

async function bootstrap(ctx) {
  const { options, ports } = ctx;
  const root = path.resolve(options.flags['--root']);
  await commandPath(root);
  const bootstrapModule = await import('./project-bootstrap.mjs');
  const inputs = await contextInputs(ctx, root, options.idea);
  if (options.prepare) {
    const bundle = await bootstrapModule.prepareBootstrap({
      prompt: options.idea,
      root,
      home: ctx.home,
      now: ports.now,
      contracts: ctx.contracts,
      knownValues: ctx.knownValues,
      ...inputs,
    });
    const target = path.join(bundle.summary.root, '.kodo', 'blueprint');
    const apply = `${ctx.cli} project apply-spec --root ${quotePath(bundle.summary.root)} --json`;
    return envelope(null, null, {
      status: 'prepared',
      bundle: { id: bundle.id, dir: bundle.dir, files: bundle.files },
      summary: bundle.summary,
      blueprint: target,
      next: [
        `Прочитай context.md, rules.md и templates/ в ${bundle.dir}.`,
        `Напиши чертёж только в ${target}: PROJECT.md, interfaces/<module>.md, spec.json (root = ${bundle.summary.root}).`,
        configStep(bundle.summary.root, path.join(bundle.dir, 'templates', 'kodo.config.json')),
        'Перед регистрацией root — корень Git-репозитория с коммитом; всё вне .kodo/blueprint закоммичено или в .gitignore.',
        `Проверь и зарегистрируй проект: ${apply}`,
      ],
      commands: [{ command: apply, why: 'После записи чертежа и коммита: проверить и зарегистрировать проект' }],
    });
  }
  const generated = await bootstrapModule.generateBlueprint({
    provider: await sessionProvider(ctx),
    client: options.flags['--client'] ?? 'codex',
    model: options.flags['--model'],
    root,
    home: ctx.home,
    prompt: options.idea,
    signal: ports.signal,
    now: ports.now,
    contracts: ctx.contracts,
    knownValues: ctx.knownValues,
    ...inputs,
  });
  const extra = { bundle: { id: generated.id }, session: generated.session, scopeChecked: generated.scopeChecked };
  if (!generated.ok) return findingsReport(generated.findings, extra);
  const apply = `${ctx.cli} project apply-spec --root ${quotePath(generated.spec.root)} --json`;
  return envelope(null, null, {
    status: 'compiled',
    ...extra,
    blueprint: path.join(generated.spec.root, '.kodo', 'blueprint'),
    modules: moduleMap(generated.spec),
    next: [
      configStep(generated.spec.root, path.join(generated.dir, 'templates', 'kodo.config.json')),
      `Проверь чертёж и зарегистрируй проект: ${apply}`,
    ],
    commands: [{ command: apply, why: 'После проверки чертежа и коммита: зарегистрировать проект' }],
  });
}

const BLUEPRINT_PREFIX = '.kodo/blueprint/';

/** apply-spec registers a wave project whose integration branch and task
 * worktrees start from the committed HEAD of root. Rule (blueprint_git_required):
 * root is the top level of a Git work tree (realpath of `rev-parse
 * --show-toplevel`), HEAD resolves to a commit, and `git status` (untracked
 * files included, ignored excluded) lists nothing outside .kodo/blueprint/.
 * A missing root is left to compile (blueprint_missing). */
async function gitFindings(root, finding) {
  const { realpath, stat } = await import('node:fs/promises');
  const { execute } = await import('./command.mjs');
  const real = await realpath(path.resolve(root)).catch(() => null);
  if (!real || !(await stat(real)).isDirectory()) return [];
  const run = args =>
    execute('git', args, { cwd: real, allowFailure: true, rawOutput: true, timeoutMs: 30000 }).catch(() => ({
      code: -1,
      stdout: '',
    }));
  const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  const required = message => [finding('blueprint_git_required', message)];
  const top = await run(['rev-parse', '--show-toplevel']);
  const topReal = top.code === 0 ? await realpath(top.stdout.trim()).catch(() => null) : null;
  if (!topReal || fold(topReal) !== fold(real))
    return required('root должен быть корнем Git-репозитория: выполните git init в каталоге проекта');
  if ((await run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).code !== 0)
    return required('В репозитории нет коммита: закоммитьте исходное состояние проекта до apply-spec');
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (status.code !== 0) return required('git status завершился ошибкой: проверьте репозиторий проекта');
  const dirty = status.stdout
    .split('\0')
    .filter(Boolean)
    .filter(entry => !entry.slice(3).startsWith(BLUEPRINT_PREFIX));
  return dirty.length
    ? required(
        `Изменения вне ${BLUEPRINT_PREFIX} не закоммичены (файлов: ${dirty.length}); ` +
          'закоммитьте их или добавьте в .gitignore — задачи волн начинаются от коммита HEAD',
      )
    : [];
}

async function applySpec(ctx) {
  const { options, contracts, knownValues, safety } = ctx;
  const { compileBlueprint, bindInterfaceEvidence, finding } = await import('./project-blueprint.mjs');
  const compiled = await compileBlueprint(options.flags['--root'], {
    contracts,
    knownValues,
    specFile: options.flags['--file'],
  });
  const findings = [...compiled.findings, ...(await gitFindings(options.flags['--root'], finding))];
  if (findings.length) return findingsReport(findings);
  quotePath(compiled.spec.root); // The root of the next hints, before evidence or the project is written.
  safety(compiled.spec);
  const { engine, repo } = await openState(ctx);
  // Content-addressed private envelopes in Kodo home; the batch prepares ACLs once.
  const owner = { artifacts: path.join(ctx.home, 'project-interfaces') };
  const bound = await engine.withEvidenceBatch(owner, write =>
    bindInterfaceEvidence(compiled, {
      persist: value => {
        safety(value);
        return write('interface', value, { headSha: null });
      },
    }),
  );
  if (!bound.ok) return findingsReport(bound.findings);
  safety(bound.spec);
  const created = await repo.apply({
    schemaVersion: 1,
    commandId: options.flags['--command-id'] || randomUUID(),
    projectId: null,
    expectedRevision: null,
    actor: 'project-cli',
    reason: 'Create Project from compiled blueprint',
    action: { op: 'create', spec: bound.spec },
  });
  const snapshot = await repo.snapshot(created.projectId);
  // Workers' self-check (ci feedback) lints JS/TS with the managed oxlint (TypeScript also needs
  // typescript); without it the feedback is blocked, never feedback_ready. Installing is the
  // coordinator's step, not a worker's.
  const tool = id => `${ctx.cli} tools install ${id} --project ${quotePath(snapshot.project.root)} --json`;
  const wave = `${ctx.cli} project next-wave ${created.projectId} --host t3 --limit 3 --json`;
  return envelope(created.projectId, snapshot.revision, {
    status: created.replayed ? 'replayed' : 'created',
    replayed: created.replayed === true,
    execution: snapshot.project.execution ?? null,
    interfaces: bound.interfaces.map(item => ({ module: item.module, sha256: item.sha256 })),
    modules: moduleMap(snapshot),
    next: [
      `Перед первой волной установи управляемый линтер самопроверки воркеров (один раз на машину, нужна сеть): ${tool('oxlint')} — для JS/TS, для TypeScript ещё typescript. Без него ci feedback воркера отвечает blocked, а не feedback_ready.`,
      `Запусти волну: ${wave}`,
    ],
    commands: [
      { command: tool('oxlint'), why: 'JS/TS-проект: линтер самопроверки воркеров, один раз на машину, нужна сеть' },
      { command: tool('typescript'), why: 'Только TypeScript-проект: проверка типов в самопроверке воркеров' },
      { command: wave, why: 'Первая волна для воркер-чатов T3' },
    ],
  });
}

async function appendFromFile(ctx, projectId, file, extra = {}) {
  const { options, contracts, knownValues, safety } = ctx;
  const { readMilestoneFile, lintMilestone } = await import('./project-bootstrap.mjs');
  const { repo } = await openState(ctx);
  const snapshot = await repo.snapshot(projectId);
  safety(snapshot);
  const at = { projectId, revision: snapshot.revision };
  let input;
  try {
    input = await readMilestoneFile(file);
  } catch (error) {
    if (!String(error?.code).startsWith('milestone_')) throw error;
    return findingsReport([{ code: error.code, message: error.message }], extra, at);
  }
  safety(input);
  const lint = lintMilestone(input, snapshot, { contracts, knownValues });
  if (!lint.ok) return findingsReport(lint.findings, extra, at);
  const applied = await repo.apply({
    schemaVersion: 1,
    commandId: options.flags['--command-id'] || randomUUID(),
    projectId,
    expectedRevision: snapshot.revision,
    actor: 'project-cli',
    reason: 'Append checked milestone',
    action: { op: 'appendMilestone', milestone: input.milestone, epics: input.epics, tasks: input.tasks },
  });
  const after = await repo.snapshot(projectId);
  return envelope(projectId, after.revision, {
    status: applied.replayed ? 'replayed' : 'appended',
    replayed: applied.replayed === true,
    ...extra,
    projectStatus: after.project.status,
    milestone: input.milestone.id,
    epics: input.epics.map(epic => epic.id),
    tasks: input.tasks.map(task => task.id),
  });
}

async function extend(ctx) {
  const { options, ports, safety } = ctx;
  // The hint quotes a file of the bundle in Kodo home.
  if (options.prepare) quotePath(await realHome(ctx.home));
  const { repo } = await openState(ctx);
  const snapshot = await repo.snapshot(options.projectId);
  safety(snapshot);
  // append-milestone admits only an accepted wave project (assertProjectReopen): refuse before a
  // bundle is written or a session starts.
  if (!ctx.contracts.isWaveProject(snapshot.project) || !['accepted', 'released'].includes(snapshot.project.status))
    throw Object.assign(new Error('Project append blocked'), { code: 'project_append_blocked' });
  const root = snapshot.project.root;
  const bootstrapModule = await import('./project-bootstrap.mjs');
  const common = {
    snapshot,
    prompt: options.idea,
    root,
    home: ctx.home,
    now: ports.now,
    contracts: ctx.contracts,
    knownValues: ctx.knownValues,
    ...(await contextInputs(ctx, root, options.idea)),
  };
  if (options.prepare) {
    // The hint's milestone file is checked before its bundle directory exists (a junction in
    // Kodo home may resolve elsewhere): an unusable path writes no bundle.
    const bundle = await bootstrapModule.prepareExtend({
      ...common,
      checkDir: dir => quotePath(path.join(dir, 'milestone.json')),
    });
    const template = path.join(bundle.dir, 'templates', 'milestone.json');
    const file = path.join(bundle.dir, 'milestone.json');
    const append = `${ctx.cli} project append-milestone ${options.projectId} --file ${quotePath(file)} --json`;
    return envelope(options.projectId, snapshot.revision, {
      status: 'prepared',
      bundle: { id: bundle.id, dir: bundle.dir, files: bundle.files },
      summary: bundle.summary,
      template,
      next: [
        `Прочитай context.md и rules.md в ${bundle.dir}; форма майлстоуна — ${template}.`,
        `Запиши майлстоун в ${file} (вне репозитория).`,
        `Проверь и добавь: ${append}`,
      ],
      commands: [{ command: append, why: 'После записи milestone.json: проверить и добавить майлстоун' }],
    });
  }
  const generated = await bootstrapModule.generateMilestone({
    ...common,
    provider: await sessionProvider(ctx),
    client: options.flags['--client'] ?? 'codex',
    model: options.flags['--model'],
    signal: ports.signal,
  });
  const extra = { bundle: { id: generated.id }, session: generated.session };
  if (!generated.ok)
    return findingsReport(generated.findings, extra, { projectId: options.projectId, revision: snapshot.revision });
  return appendFromFile(ctx, options.projectId, generated.file, extra);
}

async function realHome(home) {
  const { realpath } = await import('node:fs/promises');
  return realpath(path.resolve(home)).catch(() => path.resolve(home));
}

const HANDLERS = {
  bootstrap,
  'apply-spec': applySpec,
  extend,
  'append-milestone': ctx => appendFromFile(ctx, ctx.options.projectId, ctx.options.flags['--file']),
};

function failureReport(error, phase) {
  const argumentError = phase === 'arguments';
  const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : null;
  const dataError = DATA_CODES.includes(code) || /^(?:bootstrap|milestone|blueprint)_/.test(code ?? '');
  const exitCode = argumentError || phase === 'input' || dataError ? 1 : 2;
  // Constant diagnostics only: a constant code and, when known, a constant reason.
  return envelope(
    null,
    null,
    {
      status: exitCode === 1 ? 'invalid' : 'blocked',
      code: argumentError ? 'project_arguments' : exitCode === 1 ? 'project_invalid' : 'project_blocked',
      ...(!argumentError && code && code !== 'project_arguments' ? { reason: code } : {}),
      ...(code === 'project_path_unsafe' ? { message: PATH_UNSAFE_MESSAGE } : {}),
    },
    exitCode,
  );
}

/** Explicit, lazy composition of the project factory actions. Ports belong to
 * the coordinator/test harness: secrets, loadSecrets, home, store, openStore,
 * createEngine, provider, architecture, knowledge, now, signal and cli (command
 * prefix of the `next` hints, runtime/cli-command.mjs). */
export async function projectBlueprintCli(argv, ports = {}) {
  let options,
    outcome,
    phase = 'arguments';
  const ctx = { ports, state: null };
  try {
    options = argumentsFor(argv); // No credentials, state, files or providers before strict parsing.
    phase = 'credentials';
    const security = await import('./security.mjs');
    const secrets = ports.secrets === undefined ? await (ports.loadSecrets || security.loadSecrets)() : ports.secrets;
    const contracts = await import('./project-contracts.mjs');
    const knownValues = Object.values(secrets).filter(value => typeof value === 'string');
    const safety = value => contracts.assertDirectorSafe(value, { knownValues });
    phase = 'input';
    safety(argv);
    Object.assign(ctx, {
      options,
      secrets,
      contracts,
      knownValues,
      safety,
      home: ports.home || ports.store?.home || security.stateHome(),
      // Only an absent port means a library caller; null or anything else is checked and refused.
      cli: ports.cli === undefined ? DEFAULT_CLI : ports.cli,
    });
    phase = 'operation';
    // Actions with next hints check the prefix before the Store, a bundle or any evidence is written.
    if (options.action !== 'append-milestone' && (options.action !== 'extend' || options.prepare))
      safety(assertCliPrefix(ctx.cli));
    outcome = await HANDLERS[options.action](ctx);
    safety(outcome.report); // Guard every output value before either format.
  } catch (error) {
    outcome = failureReport(error, phase);
  } finally {
    if (ctx.state?.owned) ctx.state.store?.close();
  }
  return {
    report: outcome.report,
    exitCode: outcome.exitCode,
    output:
      options?.json || (Array.isArray(argv) && argv.includes('--json'))
        ? JSON.stringify(outcome.report, null, 2)
        : human(outcome.report),
  };
}
