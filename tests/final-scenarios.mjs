import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import * as A from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { projectCli } from '../runtime/project-cli.mjs';
import { confirmedCriteria } from './helpers/gate-review.mjs';

// Stage 13, scope ①: bounded executable offline scenarios of the final acceptance.
// Real Store, project store, production authorizer, Engine, wave director, CLI and a
// temporary Git repository; only the subscription clients are fakes. No network, no
// keys, no real providers; every scenario has its own temporary KODO_HOME.
// Scenarios B (mini Rust/Git) and D (Hearthstone) are not executed here.

const wave = { cadence: 'wave', integration: 'branch' };
const proof = id => ({ id, text: 'The observable final-scenario requirement holds.', evidenceKinds: ['acceptance'] });
const task = (id, overrides = {}) => ({
  id,
  epicId: 'e1',
  title: `Task ${id}`,
  description: `Create the files of ${id}.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`${id}.txt`],
  acceptance: [proof(`${id}-proof`)],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...overrides,
});
const envKeys = [
  'HOME',
  'USERPROFILE',
  'KODO_HOME',
  'KODO_CREDENTIAL_HOME',
  'KODO_WORKTREE_HOME',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
  'TMP',
  'TEMP',
  'TMPDIR',
];
// Variables that point Git at another repository, index, object store or configuration: removed
// for the whole scenario, including the Git processes Kodo starts.
const gitRedirects = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_TEMPLATE_DIR',
];

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

const statuses = rows => Object.fromEntries(rows.map(row => [row.id, row.status]));
const containersOf = gate => gate.containers.map(row => `${row.kind}:${row.kind === 'project' ? '' : row.id}`);

/**
 * Write the isolated global Git config through `git config --file`, which quotes the values:
 * a path containing `#` or `;` is never cut at what Git would otherwise read as a comment.
 */
function writeGitConfig(file, { template, hooks }) {
  for (const [key, value] of [
    ['init.templateDir', template],
    ['core.hooksPath', hooks],
  ]) {
    const result = spawnSync('git', ['config', '--file', file, key, value.split(path.sep).join('/')], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }
}

/**
 * A temporary directory with an isolated HOME, KODO_HOME, credentials, worktrees, temporary files
 * and Git config, and no Git redirection inherited from the caller.
 */
async function sandbox(t, prefix) {
  const parent = os.tmpdir();
  const directory = await mkdtemp(path.join(parent, `kodo-final-${prefix}-`));
  const previous = Object.fromEntries([...envKeys, ...gitRedirects].map(key => [key, process.env[key]]));
  const stores = new Set();
  // Registered before anything else: every store is closed, the environment restored and the
  // directory removed even when one of these steps fails; the failures are reported afterwards.
  t.after(async () => {
    const errors = [];
    for (const store of stores)
      try {
        store.close();
      } catch (error) {
        errors.push(error);
      }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (
      path.dirname(directory) === path.resolve(parent) &&
      path.basename(directory).startsWith(`kodo-final-${prefix}-`)
    )
      await rm(directory, { recursive: true, force: true }).catch(error => errors.push(error));
    else errors.push(new Error('Refusing to remove a directory outside the scenario temp root'));
    if (errors.length) throw new AggregateError(errors, 'Scenario cleanup failed');
  });
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home'),
    temp = path.join(directory, 'tmp'),
    template = path.join(isolated, 'git-template'),
    hooks = path.join(isolated, 'git-hooks');
  await mkdir(root);
  await mkdir(isolated);
  await mkdir(temp);
  await mkdir(template);
  await mkdir(hooks);
  // Every Git process of the scenario (the helper and Kodo's) reads only this config: no inherited
  // template is copied by `git init` and no hook runs.
  await writeFile(path.join(isolated, 'gitconfig'), '');
  writeGitConfig(path.join(isolated, 'gitconfig'), { template, hooks });
  for (const key of gitRedirects) delete process.env[key];
  Object.assign(process.env, {
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    GIT_TEMPLATE_DIR: template,
    HOME: isolated,
    USERPROFILE: isolated,
    KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
    KODO_WORKTREE_HOME: path.join(directory, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
  return { directory, root, home, stores };
}

test('Final scenario sandbox: the isolated Git config keeps template and hook paths with # and ;', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-final-gitconfig-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const odd = path.join(directory, 'a#b;c'),
    template = path.join(odd, 'git-template'),
    hooks = path.join(odd, 'git-hooks'),
    file = path.join(directory, 'gitconfig');
  await mkdir(template, { recursive: true });
  await mkdir(hooks, { recursive: true });
  await writeFile(file, '');
  writeGitConfig(file, { template, hooks });
  const read = key => {
    const result = spawnSync('git', ['config', '--file', file, '--get', key], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const forward = value => value.split(path.sep).join('/');
  assert.equal(read('init.templateDir'), forward(template));
  assert.equal(read('core.hooksPath'), forward(hooks));
});

/** Write `files` into `root`, then commit them as the user's baseline on `main`. */
async function commitBaseline(root, files) {
  for (const [name, text] of Object.entries({ '.gitattributes': '* text=auto eol=lf\n', ...files })) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  // An explicit empty template: an inherited hook can never reach the scenario repository.
  git(root, 'init', `--template=${process.env.GIT_TEMPLATE_DIR}`, '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Final Scenarios');
  git(root, 'config', 'user.email', 'kodo-final@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Final scenario baseline');
  return git(root, 'rev-parse', 'HEAD');
}

const waveConfig = (overrides = {}) => ({
  schemaVersion: 1,
  client: 'codex',
  // Task Runs of a wave project are always quick; the gates take this mode.
  executionMode: 'standard',
  concurrency: 1,
  researchBudget: 0,
  repairRounds: 3,
  commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
  delivery: { enabled: false, release: false },
  uiVerification: { enabled: false },
  security: { enabled: false },
  architecture: { enabled: false },
  ...overrides,
});

/**
 * Fake subscription clients of a wave project: a planner per task (the plan node owns the
 * task's write paths), workers writing every owned file, gate reviews and repairs.
 * `scopes` maps a task id to its write paths; hooks may write differently or fail a review.
 */
function providers(scopes, hooks) {
  const calls = { planner: [], worker: [], repair: [], reviews: [], analysis: 0, research: 0, active: 0, maxActive: 0 };
  const owned = id => scopes.get(id) ?? [`${id}.txt`];
  const provider = {
    assessTask: async () => {
      throw Object.assign(new Error('Offline assessment'), { code: 'unavailable' });
    },
    analyzeGemini: async () => {
      calls.analysis++;
      return { summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] };
    },
    discoverProviders: async () => [{ id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }],
    decideJev: async () => ({ model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' }),
    runSession: async request => {
      if (request.schema?.properties?.tasks) {
        const id = /"taskId":"([a-z][a-z0-9-]*)"/.exec(request.prompt)[1];
        calls.planner.push(id);
        return {
          sessionId: `planner-${id}`,
          output: {
            summary: `Implement ${id}`,
            tasks: [
              {
                id: 'implementation',
                role: 'developer',
                writePaths: owned(id),
                dependsOn: [],
                description: `Implement task ${id}.`,
                acceptance: [`${id} exists`],
                parallel: true,
              },
            ],
          },
        };
      }
      if (request.schema?.properties?.passed) {
        calls.reviews.push(request);
        const output = (await hooks.onReview?.(request, calls)) ?? {
          passed: true,
          findings: [],
          ...confirmedCriteria(request.schema),
        };
        return { sessionId: `review-${calls.reviews.length}`, output };
      }
      if (/Repair confirmed failures/.test(request.prompt)) {
        calls.repair.push(request.cwd);
        await hooks.onRepair?.(request, calls);
        return {
          sessionId: `repair-${calls.repair.length}`,
          output: { summary: 'repaired', checks: [], complete: true },
        };
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      calls.worker.push(id);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        await hooks.onWorker?.(id, calls, request);
        if (hooks.write) await hooks.write(id, request.cwd, calls);
        else
          for (const name of owned(id)) {
            await mkdir(path.dirname(path.join(request.cwd, name)), { recursive: true });
            await writeFile(path.join(request.cwd, name), `${id} implemented\n`);
          }
      } finally {
        calls.active--;
      }
      request.onEvent?.({ sessionId: `worker-${id}` });
      return { sessionId: `worker-${id}`, output: { summary: `${id} done`, checks: ['written'], complete: true } };
    },
  };
  const delivery = {
    deliver: async () => assert.fail('A wave project never delivers'),
    releasePackage: async () => assert.fail('A wave project never releases'),
  };
  const researcher = async () => {
    calls.research++;
    return { items: [], requests: 1, errors: [], cache: [] };
  };
  return { calls, services: { provider, researcher, delivery } };
}

/** A committed repository with a wave configuration and the real Store/Engine/authorizer/CLI over it. */
async function waveFixture(t, { prefix, files = {}, config = {}, tasks = [], hooks = {} }) {
  const box = await sandbox(t, prefix);
  const baseline = await commitBaseline(box.root, {
    'kodo.config.json': JSON.stringify(waveConfig(config), null, 2),
    'check.mjs': "console.log('final scenario check passed');\n",
    ...files,
  });
  const store = new Store(box.home, {});
  box.stores.add(store);
  const scopes = new Map(tasks.map(row => [row.id, row.writePaths]));
  const { calls, services } = providers(scopes, hooks);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A }),
  });
  // One CLI composition over the same Store and Engine (the CLI never closes a passed Store).
  const cli = async argv => {
    const result = await projectCli([...argv, '--json'], {
      home: box.home,
      secrets: {},
      store,
      createEngine: () => engine,
      architecture: null,
      knowledge: null,
    });
    return { ...result, report: JSON.parse(result.output) };
  };
  const user = () => ({
    head: git(box.root, 'rev-parse', 'HEAD'),
    branch: git(box.root, 'branch', '--show-current'),
    status: git(box.root, 'status', '--porcelain=v1', '--untracked-files=all'),
  });
  const branch = id => `refs/heads/kodo/project/${id}`;
  const branchHead = id => git(box.root, 'rev-parse', branch(id));
  const merges = id =>
    git(box.root, 'log', '--first-parent', '--merges', '--format=%s', branch(id)).split('\n').filter(Boolean);
  const taskRuns = () => store.listRuns(box.root).filter(run => run.directorBinding?.kind !== 'gate');
  // The private integration worktree that holds the project branch.
  const integrationWorktree = id =>
    git(box.root, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find(block => block.includes(`branch ${branch(id)}`))
      .split(/\r?\n/)[0]
      .slice('worktree '.length);
  return {
    ...box,
    baseline,
    store,
    engine,
    repo,
    calls,
    scopes,
    cli,
    user,
    branchHead,
    merges,
    taskRuns,
    integrationWorktree,
    director: () => createProjectDirector({ repo, engine }),
  };
}

/** A ProjectSpec v1 of a wave project rooted at `root`. */
function projectSpec(root, { id, tasks, epics, milestones }) {
  return {
    schemaVersion: 1,
    id,
    root,
    title: `Final scenario ${id}`,
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline final acceptance fixture.',
    architectureRefs: [],
    milestones: milestones ?? [
      { id: 'm1', title: 'Milestone', acceptance: [proof('m1-proof')], releaseRequired: false },
    ],
    epics:
      epics ??
      [...new Set(tasks.map(row => row.epicId))].map(epic => ({
        id: epic,
        milestoneId: 'm1',
        title: `Epic ${epic}`,
        acceptance: [proof(`${epic}-proof`)],
      })),
    tasks,
    execution: wave,
  };
}

/** `kodo project create --file` with a spec written outside the repository. */
async function createProject(f, spec) {
  const file = path.join(f.directory, `${spec.id}.json`);
  await writeFile(file, JSON.stringify(spec, null, 2));
  const created = await f.cli(['create', '--file', file]);
  assert.equal(created.exitCode, 0, created.output);
  return created.report.projectId;
}

/** Each `Kodo: integrate <id>` merge appears exactly once on the project branch. */
function assertMergedOnce(f, projectId, ids) {
  const subjects = f.merges(projectId).filter(subject => subject.startsWith('Kodo: integrate '));
  assert.deepEqual(
    subjects.filter(subject => subject !== 'Kodo: integrate gate repairs').toSorted(),
    ids.map(id => `Kodo: integrate ${id}`).toSorted(),
  );
}

// --- Scenario A -------------------------------------------------------------------------------

test(
  'Scenario A: a CSS button colour change takes the fast path (quick, no research or Gemini) and changes only the stylesheet',
  { timeout: 300000 },
  async t => {
    const box = await sandbox(t, 'css');
    const css = 'styles/button.css';
    const base = await commitBaseline(box.root, {
      'index.html':
        '<!doctype html>\n<link rel="stylesheet" href="styles/button.css">\n<button class="button">Go</button>\n',
      [css]: '.button {\n  color: red;\n  padding: 4px 8px;\n}\n',
      'styles/layout.css': 'body {\n  margin: 0;\n}\n',
      'verify.mjs':
        "import { readFileSync } from 'node:fs';\n" +
        "const css = readFileSync('styles/button.css', 'utf8');\n" +
        "if (!/\\.button\\s*\\{[^}]*color:/.test(css)) {\n  console.error('the button has no colour');\n  process.exit(1);\n}\n",
      'kodo.config.json': JSON.stringify(
        {
          schemaVersion: 1,
          client: 'codex',
          repairRounds: 3,
          researchBudget: 5,
          commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [], deploy: [], smoke: [] },
          delivery: { enabled: false, release: false },
          uiVerification: { enabled: false },
          security: { enabled: false },
          architecture: { enabled: false },
        },
        null,
        2,
      ),
    });
    const before = {
      head: git(box.root, 'rev-parse', 'HEAD'),
      status: git(box.root, 'status', '--porcelain=v1', '--untracked-files=all'),
    };
    const calls = [];
    const provider = {
      assessTask: async () => {
        calls.push('assessment');
        throw Object.assign(new Error('Offline assessment'), { code: 'unavailable' });
      },
      analyzeGemini: async () => {
        calls.push('analysis');
        return { summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] };
      },
      discoverProviders: async () => {
        calls.push('discovery');
        return [{ id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }];
      },
      decideJev: async () => {
        calls.push('routing');
        return { model: 'codex-sol', parallel: false, confidence: 0.95, sessionMode: 'fresh' };
      },
      runSession: async request => {
        const sessionId = `session-${calls.length}`;
        request.onEvent?.({ sessionId });
        if (request.schema.properties.tasks) {
          calls.push('plan');
          return {
            sessionId,
            output: {
              summary: 'Recolour the button',
              tasks: [
                {
                  id: 'recolour',
                  role: 'developer',
                  description: 'Make the button blue',
                  writePaths: [css],
                  dependsOn: [],
                  acceptance: ['The button colour is blue'],
                  parallel: false,
                },
              ],
            },
          };
        }
        if (request.schema.properties.passed) {
          calls.push('review');
          return { sessionId, output: { passed: true, findings: [] } };
        }
        calls.push('worker');
        const file = path.join(request.cwd, css);
        await writeFile(file, (await readFile(file, 'utf8')).replace('color: red', 'color: blue'));
        return { sessionId, output: { complete: true, summary: 'Button recoloured', checks: ['colour updated'] } };
      },
    };
    const store = new Store(box.home, {});
    box.stores.add(store);
    const researcher = async () => {
      calls.push('research');
      return { requests: 0, items: [], errors: [], cache: [] };
    };
    const engine = new Engine({ store, secrets: {}, provider, researcher });

    const run = await engine.create(`Поменять цвет кнопки в ${css} на синий.`, { project: box.root });
    const result = await engine.run(run.id);
    assert.equal(result.state, 'succeeded', result.error?.message);
    assert.deepEqual(
      [result.executionMode.selected, result.executionMode.source, result.executionMode.requested],
      ['quick', 'fast-path', null],
    );
    assert.deepEqual(result.fastPath.files, [css]);
    assert.deepEqual(
      calls.filter(call => call !== 'discovery'),
      ['plan', 'worker', 'review'],
      'no assessment, routing, Gemini analysis or research',
    );
    assert.equal(result.research.requests, 0);
    assert.equal(result.analysis.kind, 'local');
    assert.equal(result.review.passed, true, 'the independent review is not skipped');
    assert.equal(result.baseSha, base);
    assert.deepEqual(git(result.cwd, 'diff', '--name-only', result.baseSha, result.headSha).split('\n'), [css]);
    assert.equal(
      git(result.cwd, 'show', `${result.headSha}:${css}`),
      '.button {\n  color: blue;\n  padding: 4px 8px;\n}',
    );
    assert.deepEqual(
      {
        head: git(box.root, 'rev-parse', 'HEAD'),
        status: git(box.root, 'status', '--porcelain=v1', '--untracked-files=all'),
      },
      before,
      "the user's checkout is untouched",
    );
    assert.match(await readFile(path.join(box.root, css), 'utf8'), /color: red/);
  },
);

// --- Scenario C -------------------------------------------------------------------------------

const C_EPICS = [
  ['alpha', 'a'],
  ['beta', 'b'],
  ['gamma', 'g'],
];

/** 25 tasks: Wave 0 (`base`) and 8 tasks in each of three epics, ranked by descending priority. */
function backlogTasks() {
  const tasks = [
    task('base', { epicId: 'foundation', owner: 'architect', writePaths: ['src/base.txt'], priority: 99 }),
  ];
  let priority = 90;
  for (const [epic, letter] of C_EPICS)
    for (let index = 1; index <= 8; index++) {
      const id = `${letter}0${index}`;
      tasks.push(task(id, { epicId: epic, dependsOn: ['base'], writePaths: [`src/${epic}/${id}.txt`], priority }));
      priority--;
    }
  return tasks;
}

const BACKLOG_PROJECT = `# Большой backlog

## Цель

Проверить, что backlog больше 24 задач исполняется ограниченными окнами.

## Модули

- foundation — общий каркас: src/base.txt.
- alpha, beta, gamma — по восемь независимых файлов в src/<модуль>/.

## Стек

Node.js 24, ESM.

## Критерии готовности

Все задачи приняты гейтами эпиков, проект принят.
`;

test(
  'Scenario C: a 25-task blueprint backlog in three epics runs in bounded windows (plan --limit 3, drain --concurrency 2 --max-waves 5) to accepted',
  { timeout: 1800000 },
  async t => {
    const tasks = backlogTasks();
    const f = await waveFixture(t, {
      prefix: 'backlog',
      tasks,
      hooks: {
        // Paired tasks stay inside their sessions until the partner arrives: windows really overlap.
        onWorker: async (id, calls) => {
          if (id === 'base') return;
          for (let i = 0; i < 1200 && calls.active < 2; i++) await delay(25);
        },
      },
    });
    const dir = path.join(f.root, '.kodo', 'blueprint');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'PROJECT.md'), BACKLOG_PROJECT);
    const spec = projectSpec(f.root, {
      id: 'final-backlog',
      tasks,
      epics: [
        { id: 'foundation', milestoneId: 'm1', title: 'Wave 0', acceptance: [proof('foundation-proof')] },
        ...C_EPICS.map(([epic]) => ({
          id: epic,
          milestoneId: 'm1',
          title: `Epic ${epic}`,
          acceptance: [proof(`${epic}-proof`)],
        })),
      ],
    });
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
    const before = f.user();

    const applied = await f.cli(['apply-spec', '--root', f.root]);
    assert.equal(applied.exitCode, 0, applied.output);
    assert.equal(applied.report.result.status, 'created');
    assert.deepEqual(applied.report.result.modules.waveZero, ['base']);
    const id = applied.report.projectId;
    assert.equal(f.repo.snapshot(id).tasks.length, 25, 'the backlog is larger than one 24-task horizon');

    // Every task Run of the drain goes through Engine.run: count the Runs and attempts in flight.
    const runEngine = f.engine.run.bind(f.engine);
    const live = new Set();
    let maxLive = 0,
      maxInProgress = 0;
    f.engine.run = async (runId, options) => {
      const taskId = f.store.getRun(runId).directorBinding.taskId;
      live.add(taskId);
      maxLive = Math.max(maxLive, live.size);
      const inProgress = f.repo
        .snapshot(id)
        .currentAttempts.filter(row => ['reserved', 'running', 'verifying'].includes(row.status)).length;
      maxInProgress = Math.max(maxInProgress, inProgress);
      try {
        return await runEngine(runId, options);
      } finally {
        live.delete(taskId);
      }
    };

    // The horizon order: Wave 0, then descending priority (all other tasks have the same depth).
    const order = tasks.map(row => row.id);
    const drains = [];
    for (let call = 0; call < 6; call++) {
      const started = f.calls.worker.length;
      const plan = await f.cli(['plan', id, '--limit', '3']);
      assert.equal(plan.exitCode, 0, plan.output);
      assert.equal(plan.report.result.dryRun, true);
      const remaining = order.slice(started);
      const ready = started === 0 ? ['base'] : remaining;
      assert.deepEqual(plan.report.result.taskIds, ready.slice(0, 3), `plan window before drain ${call + 1}`);
      assert.ok(
        plan.report.result.blocked.some(row =>
          row.reasons.includes(started === 0 ? 'dependency_not_accepted:base' : 'horizon_limit'),
        ),
        'the tasks beyond the window wait',
      );
      const drained = await f.cli(['drain', id, '--concurrency', '2', '--max-waves', '5']);
      assert.equal(drained.exitCode, 0, drained.output);
      const result = drained.report.result;
      drains.push({ status: result.status, waves: result.waves, integrated: result.integrated.length });
      // The first wave of this call is the head of the window the plan showed.
      const firstWave = f.calls.worker.slice(started, started + (started === 0 ? 1 : 2));
      assert.deepEqual(firstWave.toSorted(), plan.report.result.taskIds.slice(0, firstWave.length).toSorted());
      assert.deepEqual(result.integrated.toSorted(), f.calls.worker.slice(started).toSorted());
      if (result.status === 'accepted') break;
      assert.equal(result.status, 'max_waves', drained.output);
      assert.equal(result.waves, 5);
    }
    assert.deepEqual(drains, [
      { status: 'max_waves', waves: 5, integrated: 9 },
      { status: 'max_waves', waves: 5, integrated: 10 },
      { status: 'accepted', waves: 3, integrated: 6 },
    ]);
    // Waves follow the horizon order: [base], then pairs in descending priority.
    assert.equal(f.calls.worker[0], 'base');
    for (let index = 1; index < order.length; index += 2)
      assert.deepEqual(f.calls.worker.slice(index, index + 2).toSorted(), order.slice(index, index + 2).toSorted());
    assert.equal(maxLive, 2, 'never more task Runs at once than the window, and the window was used');
    assert.equal(maxInProgress, 2, 'never more attempts in progress than the window');
    assert.equal(f.calls.maxActive, 2, 'never more worker sessions at once than the window');
    assert.equal(f.calls.worker.length, 25, 'every task ran exactly once');
    assert.equal(new Set(f.calls.worker).size, 25);

    const snapshot = f.repo.snapshot(id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.ok(snapshot.tasks.every(row => row.status === 'accepted'));
    assert.ok(snapshot.epics.every(row => row.status === 'accepted'));
    assert.deepEqual(snapshot.gates.map(containersOf), [
      ['epic:foundation'],
      ['epic:alpha'],
      ['epic:beta'],
      ['epic:gamma', 'milestone:m1', 'project:'],
    ]);
    assert.ok(snapshot.gates.every(gate => f.store.getRun(gate.runId).state === 'succeeded'));
    assertMergedOnce(f, id, order);
    for (const row of tasks)
      assert.equal(git(f.root, 'show', `${f.branchHead(id)}:${row.writePaths[0]}`), `${row.id} implemented`);
    for (const run of f.taskRuns()) {
      assert.equal(run.verificationProfile, 'task-fast');
      assert.equal(run.executionMode.selected, 'quick');
      assert.ok(run.config.concurrency <= 2);
    }
    assert.deepEqual(f.user(), before, "the user's HEAD, branch and working tree are untouched");
    const again = await f.cli(['drain', id, '--concurrency', '2', '--max-waves', '5']);
    assert.deepEqual([again.exitCode, again.report.result.status, again.report.result.waves], [0, 'accepted', 0]);
    const empty = await f.cli(['plan', id, '--limit', '3']);
    assert.deepEqual([empty.exitCode, empty.report.result.taskIds], [2, []]);
  },
);

// --- Scenario E -------------------------------------------------------------------------------

const calcTest =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/calc.mjs';\n" +
  "test('adds two numbers', () => assert.equal(add(2, 3), 5));\n";
const otherTest =
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  "test('keeps the other behaviour', () => assert.equal(1 + 1, 2));\n";

test(
  'Scenario E1: a task that deletes an existing test is blocked by the behaviour gate and never integrated',
  { timeout: 600000 },
  async t => {
    const tasks = [task('cleanup', { writePaths: ['src/calc.mjs', 'tests/calc.test.mjs'] })];
    const f = await waveFixture(t, {
      prefix: 'tests-deleted',
      tasks,
      config: {
        commands: { test: [{ command: process.execPath, args: ['--test'] }], build: [], deploy: [], smoke: [] },
      },
      files: {
        'src/calc.mjs': 'export const add = (a, b) => a + b;\n',
        'tests/calc.test.mjs': calcTest,
        'tests/other.test.mjs': otherTest,
      },
      hooks: {
        // The worker "simplifies" the module and removes its test; the repair changes nothing.
        write: async (_id, cwd) => {
          await writeFile(path.join(cwd, 'src/calc.mjs'), 'export const add = (a, b) => a + b; // simplified\n');
          await rm(path.join(cwd, 'tests/calc.test.mjs'));
        },
      },
    });
    const id = await createProject(f, projectSpec(f.root, { id: 'final-tests-deleted', tasks }));
    const before = f.user();
    const drained = await f.cli(['drain', id]);
    assert.equal(drained.exitCode, 2, drained.output);
    assert.equal(drained.report.result.status, 'blocked');
    assert.deepEqual(drained.report.result.integrated, []);
    assert.ok(
      drained.report.result.blockers.some(row => row.kind === 'task' && row.id === 'cleanup'),
      drained.output,
    );
    const [run] = f.taskRuns();
    assert.equal(run.state, 'blocked');
    assert.equal(run.behavior.passed, false);
    assert.deepEqual(
      run.behavior.findings.map(finding => [finding.rule, finding.file]),
      [['test_deleted', 'tests/calc.test.mjs']],
    );
    const snapshot = f.repo.snapshot(id);
    assert.notEqual(snapshot.project.status, 'accepted');
    // The attempt is blocked; the task waits in ready for an explicit --retry-failed.
    assert.deepEqual(statuses(snapshot.tasks), { cleanup: 'ready' });
    assert.equal(snapshot.currentAttempts[0].status, 'blocked');
    assert.deepEqual(f.merges(id), [], 'nothing was integrated');
    assert.equal(git(f.root, 'show', `${f.branchHead(id)}:tests/calc.test.mjs`), calcTest.trim());
    assert.equal(f.calls.reviews.length, 0, 'no review was asked to approve the deletion');
    assert.deepEqual(f.user(), before, "the user's checkout is untouched");
  },
);

test(
  'Scenario E2: a write outside the task writePaths blocks that task; its wave neighbour still integrates',
  { timeout: 600000 },
  async t => {
    const tasks = [task('rogue', { priority: 90 }), task('good', { priority: 80 })];
    const f = await waveFixture(t, {
      prefix: 'outside-scope',
      tasks,
      hooks: {
        write: async (id, cwd) => {
          await writeFile(path.join(cwd, `${id}.txt`), `${id} implemented\n`);
          if (id === 'rogue') await writeFile(path.join(cwd, 'outside.txt'), 'not in the task scope\n');
        },
      },
    });
    const id = await createProject(f, projectSpec(f.root, { id: 'final-outside-scope', tasks }));
    const before = f.user();
    const drained = await f.cli(['drain', id, '--concurrency', '2']);
    assert.equal(drained.exitCode, 2, drained.output);
    const result = drained.report.result;
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.integrated, ['good']);
    const rogue = f.taskRuns().find(run => run.directorBinding.taskId === 'rogue');
    assert.equal(rogue.state, 'blocked');
    // The Engine scope check (`scope_conflict`) names the file; the bounded repair cannot widen the scope.
    const [node] = Object.values(rogue.nodes);
    assert.equal(node.status, 'blocked');
    assert.match(node.error, /outside\.txt/);
    assert.ok(!/rogue\.txt/.test(node.error), 'only the file outside the scope is reported');
    assert.deepEqual(
      result.blockers.filter(row => row.id === 'rogue').map(row => [row.kind, row.code]),
      [['task', node.stopped]],
      drained.output,
    );
    const snapshot = f.repo.snapshot(id);
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.deepEqual(statuses(snapshot.tasks), { rogue: 'ready', good: 'integrated' });
    assert.equal(snapshot.currentAttempts.find(row => row.taskId === 'rogue').status, 'blocked');
    assertMergedOnce(f, id, ['good']);
    const files = git(f.root, 'ls-tree', '-r', '--name-only', f.branchHead(id)).split('\n');
    assert.ok(!files.includes('outside.txt') && !files.includes('rogue.txt'), 'nothing of the rogue task entered');
    assert.deepEqual(f.user(), before, "the user's checkout is untouched");
  },
);

test(
  'Scenario E3: a merge conflict in the integration branch is project_integration_conflict, the branch and the user checkout stay intact',
  { timeout: 900000 },
  async t => {
    // Disjoint writePaths keep two Kodo tasks of one wave conflict-free by construction, and a later
    // wave starts from the current integration head. A conflict needs two changes of one file from
    // different bases: task `y` (an external T3 chat) edits a.txt from the head after task `a`,
    // while the gate of epic e1 repairs a.txt of task `a` before `y` reports its commit.
    let failedReview = false;
    const tasks = [
      task('a', { priority: 90 }),
      task('b', { priority: 50 }),
      task('y', { epicId: 'e2', dependsOn: ['a'], writePaths: ['a.txt'], priority: 80 }),
    ];
    const f = await waveFixture(t, {
      prefix: 'conflict',
      tasks,
      hooks: {
        onReview: request => {
          if (!request.schema.properties.criteria || failedReview) return undefined;
          failedReview = true;
          return {
            passed: false,
            findings: [{ file: 'a.txt', severity: 'major', problem: 'a.txt is not final', fix: 'Fix a.txt' }],
            ...confirmedCriteria(request.schema),
          };
        },
        onRepair: request => writeFile(path.join(request.cwd, 'a.txt'), 'a fixed by the e1 gate\n'),
      },
    });
    const id = await createProject(f, projectSpec(f.root, { id: 'final-conflict', tasks }));
    const before = f.user();

    const first = await f.cli(['drain', id, '--concurrency', '1', '--max-waves', '1']);
    assert.deepEqual(
      [first.exitCode, first.report.result.status, first.report.result.integrated],
      [0, 'max_waves', ['a']],
    );
    const next = await f.cli(['next-wave', id, '--host', 't3', '--limit', '1']);
    assert.equal(next.exitCode, 0, next.output);
    const [brief] = next.report.result.briefs;
    assert.equal(brief.taskId, 'y');
    assert.equal(brief.baseSha, f.branchHead(id));

    // The drain integrates b beside the external y; the e1 gate repairs a.txt and is accepted.
    const second = await f.cli(['drain', id, '--concurrency', '2']);
    assert.deepEqual(second.report.result.integrated, ['b'], second.output);
    assert.equal(f.calls.repair.length, 1, 'one repair round in the e1 gate');
    let snapshot = f.repo.snapshot(id);
    assert.deepEqual(statuses(snapshot.epics), { e1: 'accepted', e2: 'running' });
    const repaired = f.branchHead(id);
    assert.equal(git(f.root, 'show', `${repaired}:a.txt`), 'a fixed by the e1 gate');

    // The worker chat of y edits a.txt from its older base and reports the commit.
    await writeFile(path.join(brief.worktree, 'a.txt'), 'a extended by y\n');
    git(brief.worktree, 'add', '-A');
    git(brief.worktree, 'commit', '-m', 'Implement y');
    const head = git(brief.worktree, 'rev-parse', 'HEAD');
    const completed = await f.cli(['complete-task', id, 'y', '--head', head]);
    assert.equal(completed.exitCode, 2, completed.output);
    assert.deepEqual(
      [completed.report.result.status, completed.report.result.code],
      ['blocked', 'project_integration_conflict'],
    );
    assert.equal(f.branchHead(id), repaired, 'the conflicting merge was aborted: the branch head is unchanged');
    const worktree = f.integrationWorktree(id);
    assert.equal(git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'), '');
    assert.notEqual(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: worktree, windowsHide: true }).status,
      0,
      'no unfinished merge is left behind',
    );
    const yRun = f.store.getRun(brief.runId);
    assert.deepEqual([yRun.integration.status, yRun.integration.code], ['failed', 'project_integration_conflict']);
    snapshot = f.repo.snapshot(id);
    assert.equal(snapshot.currentAttempts.find(row => row.taskId === 'y').status, 'blocked');
    assert.notEqual(snapshot.project.status, 'accepted');
    assert.deepEqual(f.user(), before, "the user's HEAD, branch and working tree are untouched");

    // Recovery: the same host retries y from the current head; the project is accepted.
    const retried = await f.cli(['next-wave', id, '--host', 't3', '--limit', '1', '--retry-failed']);
    assert.equal(retried.exitCode, 0, retried.output);
    const [again] = retried.report.result.briefs;
    assert.equal(again.taskId, 'y');
    assert.equal(again.baseSha, repaired);
    await writeFile(path.join(again.worktree, 'a.txt'), 'a fixed by the e1 gate, extended by y\n');
    git(again.worktree, 'add', '-A');
    git(again.worktree, 'commit', '-m', 'Implement y again');
    const retry = await f.cli(['complete-task', id, 'y', '--head', git(again.worktree, 'rev-parse', 'HEAD')]);
    assert.equal(retry.exitCode, 0, retry.output);
    assert.equal(retry.report.result.status, 'integrated');
    snapshot = f.repo.snapshot(id);
    assert.equal(snapshot.project.status, 'accepted', JSON.stringify(retry.report.result));
    assert.equal(git(f.root, 'show', `${f.branchHead(id)}:a.txt`), 'a fixed by the e1 gate, extended by y');
    assertMergedOnce(f, id, ['a', 'b', 'y']);
    assert.deepEqual(f.user(), before);
  },
);

test(
  'Scenario E4: a crash and an abort in the middle of drain; repeated drains continue without duplicate merges to accepted',
  { timeout: 900000 },
  async t => {
    let controller = new AbortController();
    /** @type {'crash' | 'abort' | 'retry'} */
    let phase = 'crash';
    /** @type {string | null} */
    let barrierFailure = null;
    const tasks = [
      task('alpha', { priority: 90 }),
      task('beta', { priority: 80 }),
      task('gamma', { priority: 70 }),
      task('delta', { priority: 60 }),
    ];
    const f = await waveFixture(t, {
      prefix: 'interrupt',
      tasks,
      hooks: {
        onWorker: async (id, calls) => {
          // The second drain is interrupted while gamma and delta are both inside their first
          // sessions: delta's session ends only after the abort, so neither can finish first on any
          // platform. A barrier that times out fails the scenario instead of weakening it.
          const barrier = phase === 'abort' && ['gamma', 'delta'].includes(id);
          for (let i = 0; i < (barrier ? 4800 : 1200) && calls.active < 2; i++) await delay(25);
          if (!barrier) return;
          if (calls.active < 2) barrierFailure ??= `${id} entered its session without the other one`;
          if (id === 'gamma') controller.abort();
          else {
            for (let i = 0; i < 4800 && !controller.signal.aborted; i++) await delay(25);
            if (!controller.signal.aborted) barrierFailure ??= 'delta waited 120 s without the abort';
          }
        },
      },
    });
    const id = await createProject(f, projectSpec(f.root, { id: 'final-interrupt', tasks }));
    const before = f.user();

    // 1. A crash after the first merge commit and before its record (the process dies).
    const updateRun = f.store.updateRun.bind(f.store);
    let crashed = false;
    f.store.updateRun = (runId, patch, options) => {
      if (!crashed && patch.integration?.status === 'merged') {
        crashed = true;
        throw Object.assign(new Error('Injected crash after the merge commit'), { code: 'fixture_crash' });
      }
      return updateRun(runId, patch, options);
    };
    await assert.rejects(f.director().drain(id, { concurrency: 2 }), /Injected crash after the merge commit/);
    f.store.updateRun = updateRun;
    assert.equal(crashed, true);
    assert.equal(f.taskRuns().filter(run => run.integration?.status === 'pending').length, 1);
    assert.equal(f.merges(id).length, 2, 'both merge commits exist, one of them unrecorded');

    // 2. The next drain recovers the unrecorded merge, starts gamma and delta and is aborted.
    phase = 'abort';
    const aborted = await f.director().drain(id, { concurrency: 2, signal: controller.signal });
    assert.equal(barrierFailure, null, 'both sessions were in flight when the drain was aborted');
    assert.equal(aborted.status, 'cancelled', JSON.stringify(aborted));
    let snapshot = f.repo.snapshot(id);
    assert.ok(
      !snapshot.project.paused && snapshot.project.status !== 'cancelled',
      'an abort stops the drain, not the project',
    );
    assert.deepEqual([statuses(snapshot.tasks).alpha, statuses(snapshot.tasks).beta], ['integrated', 'integrated']);
    assert.equal(f.merges(id).length, 2, 'the recovery made no second merge commit');
    // The aborted attempts of gamma and delta are settled and not integrated: a plain drain would not
    // continue them, only --retry-failed opens new attempts.
    const abortedAttempts = Object.fromEntries(
      ['gamma', 'delta'].map(taskId => [taskId, snapshot.currentAttempts.find(row => row.taskId === taskId)]),
    );
    for (const [taskId, attempt] of Object.entries(abortedAttempts)) {
      assert.ok(attempt, `${taskId} has an attempt`);
      assert.ok(['cancelled', 'blocked', 'failed'].includes(attempt.status), `${taskId}: ${attempt.status}`);
    }

    // 3. A repeated drain continues: the cancelled attempts are retried, the project is accepted.
    phase = 'retry';
    controller = new AbortController();
    const resumed = await f.cli(['drain', id, '--concurrency', '2', '--retry-failed']);
    assert.equal(resumed.exitCode, 0, resumed.output);
    assert.equal(resumed.report.result.status, 'accepted', resumed.output);
    snapshot = f.repo.snapshot(id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.ok(snapshot.tasks.every(row => row.status === 'accepted'));
    assertMergedOnce(f, id, ['alpha', 'beta', 'gamma', 'delta']);
    for (const [taskId, attempt] of Object.entries(abortedAttempts)) {
      const current = snapshot.currentAttempts.find(row => row.taskId === taskId);
      assert.notEqual(current.id, attempt.id, `${taskId} was retried by a new attempt`);
      assert.ok(current.number > attempt.number, `${taskId}: attempt ${current.number} after ${attempt.number}`);
      assert.equal(current.status, 'accepted');
    }
    const runsOf = taskId => f.taskRuns().filter(run => run.directorBinding.taskId === taskId);
    assert.equal(runsOf('alpha').length, 1, 'the crashed integration reused its Run');
    assert.equal(runsOf('beta').length, 1);
    assert.deepEqual(
      f.calls.worker.filter(name => ['alpha', 'beta'].includes(name)).toSorted(),
      ['alpha', 'beta'],
      'finished tasks never ran again',
    );
    assert.deepEqual(f.user(), before, "the user's checkout is untouched");
  },
);

// --- Scenario F -------------------------------------------------------------------------------

const moduleOf = id => `src/${id}.mjs`;
const testOf = id => `tests/${id}.test.mjs`;
// Each task adds a module and a node:test test for it; `extra` reuses `left` (compatible extension).
const sources = {
  base: ['export const base = () => "base";\n', "import { base } from '../src/base.mjs';\n", "base() === 'base'"],
  left: ['export const left = n => n + 1;\n', "import { left } from '../src/left.mjs';\n", 'left(1) === 2'],
  right: ['export const right = n => n * 2;\n', "import { right } from '../src/right.mjs';\n", 'right(2) === 4'],
  extra: [
    "import { left } from './left.mjs';\nexport const extra = n => left(left(n));\n",
    "import { extra } from '../src/extra.mjs';\n",
    'extra(1) === 3',
  ],
};
const testText = id =>
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
  sources[id][1] +
  `test('${id} behaves', () => assert.ok(${sources[id][2]}));\n`;

/** `node --test` in a detached checkout of `head`, without the parent's test runner context. */
function nodeTestAt(f, head) {
  const checkout = path.join(f.directory, `checkout-${head.slice(0, 12)}`);
  git(f.root, 'worktree', 'add', '--detach', checkout, head);
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec'], {
      cwd: checkout,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    git(f.root, 'worktree', 'remove', '--force', checkout);
  }
}

test(
  'Scenario F: an accepted project is extended (extend --prepare → append-milestone → drain) and accepted again; earlier tests still pass and earlier records are unchanged',
  { timeout: 900000 },
  async t => {
    const scoped = id => [moduleOf(id), testOf(id)];
    const tasks = [
      task('base', { epicId: 'foundation', owner: 'architect', writePaths: scoped('base') }),
      task('left', { epicId: 'core', dependsOn: ['base'], writePaths: scoped('left') }),
      task('right', { epicId: 'core', dependsOn: ['base'], writePaths: scoped('right') }),
    ];
    const f = await waveFixture(t, {
      prefix: 'extend',
      tasks,
      config: {
        commands: { test: [{ command: process.execPath, args: ['--test'] }], build: [], deploy: [], smoke: [] },
      },
      hooks: {
        write: async (id, cwd) => {
          await mkdir(path.join(cwd, 'src'), { recursive: true });
          await mkdir(path.join(cwd, 'tests'), { recursive: true });
          await writeFile(path.join(cwd, moduleOf(id)), sources[id][0]);
          await writeFile(path.join(cwd, testOf(id)), testText(id));
        },
      },
    });
    const dir = path.join(f.root, '.kodo', 'blueprint');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'PROJECT.md'),
      '# Расширяемый проект\n\n## Цель\n\nПринять проект и расширить его новой фичей.\n\n' +
        '## Модули\n\n- foundation — base.\n- core — left и right.\n\n## Стек\n\nNode.js 24, ESM, node:test.\n\n' +
        '## Критерии готовности\n\nВсе тесты проходят, проект принят.\n',
    );
    await writeFile(
      path.join(dir, 'spec.json'),
      JSON.stringify(
        projectSpec(f.root, {
          id: 'final-extend',
          tasks,
          epics: [
            { id: 'foundation', milestoneId: 'm1', title: 'Wave 0', acceptance: [proof('foundation-proof')] },
            { id: 'core', milestoneId: 'm1', title: 'Core', acceptance: [proof('core-proof')] },
          ],
        }),
        null,
        2,
      ),
    );
    const before = f.user();
    const applied = await f.cli(['apply-spec', '--root', f.root]);
    assert.equal(applied.exitCode, 0, applied.output);
    const id = applied.report.projectId;
    const first = await f.cli(['drain', id, '--concurrency', '2']);
    assert.equal(first.exitCode, 0, first.output);
    assert.equal(first.report.result.status, 'accepted', first.output);
    const closed = f.repo.snapshot(id);
    assert.equal(closed.project.status, 'accepted');
    const acceptedHead = f.branchHead(id);
    const earlier = nodeTestAt(f, acceptedHead);
    assert.equal(earlier.status, 0, earlier.output);
    assert.match(earlier.output, /pass 3\b/);

    // The new feature: the prepared bundle receives the milestone the main chat wrote.
    const prepared = await f.cli(['extend', id, 'Добавить extra поверх left', '--prepare']);
    assert.equal(prepared.exitCode, 0, prepared.output);
    assert.equal(prepared.report.result.status, 'prepared');
    const file = path.join(prepared.report.result.bundle.dir, 'milestone.json');
    f.scopes.set('extra', scoped('extra'));
    await writeFile(
      file,
      JSON.stringify({
        milestone: { id: 'm2', title: 'Extra feature', acceptance: [proof('m2-proof')], releaseRequired: false },
        epics: [{ id: 'feature', milestoneId: 'm2', title: 'Feature', acceptance: [proof('feature-proof')] }],
        tasks: [task('extra', { epicId: 'feature', dependsOn: ['left'], writePaths: scoped('extra') })],
      }),
    );
    const appended = await f.cli(['append-milestone', id, '--file', file]);
    assert.equal(appended.exitCode, 0, appended.output);
    assert.deepEqual([appended.report.result.status, appended.report.result.projectStatus], ['appended', 'running']);

    const second = await f.cli(['drain', id, '--concurrency', '2']);
    assert.equal(second.exitCode, 0, second.output);
    assert.equal(second.report.result.status, 'accepted', second.output);
    assert.deepEqual(second.report.result.integrated, ['extra']);
    assert.deepEqual(f.calls.worker.toSorted(), ['base', 'extra', 'left', 'right'], 'no earlier task ran again');

    const reopened = f.repo.snapshot(id);
    assert.equal(reopened.project.status, 'accepted');
    assert.equal(reopened.project.reopened.length, 1);
    for (const key of ['milestones', 'epics', 'tasks'])
      for (const row of closed[key])
        assert.deepEqual(
          reopened[key].find(item => item.id === row.id),
          row,
          `${key}:${row.id} is unchanged by the extension`,
        );
    assert.deepEqual(reopened.gates.slice(0, closed.gates.length), closed.gates, 'earlier gates are unchanged');
    const added = reopened.gates.slice(closed.gates.length);
    assert.deepEqual(added.map(containersOf), [['epic:feature', 'milestone:m2', 'project:']]);
    // The final gate ran the complete node --test of the extended product: earlier tests and the new one.
    const gate = f.store.getRun(added[0].runId);
    assert.equal(gate.state, 'succeeded');
    const shape = JSON.stringify(
      gate.checks.results.map(({ kind, args, exitCode, tests }) => ({ kind, args, exitCode, tests })),
    );
    const counted = gate.checks.results.filter(item => typeof item.tests === 'number');
    assert.equal(counted.length, 1, shape);
    assert.deepEqual([counted[0].exitCode, counted[0].tests], [0, 4], shape);

    const finalHead = f.branchHead(id);
    for (const name of ['base', 'left', 'right'])
      for (const file of scoped(name))
        assert.equal(
          git(f.root, 'diff', '--name-only', acceptedHead, finalHead, '--', file),
          '',
          `${file} is unchanged by the extension`,
        );
    const after = nodeTestAt(f, finalHead);
    assert.equal(after.status, 0, after.output);
    assert.match(after.output, /pass 4\b/);
    for (const name of ['base', 'left', 'right', 'extra']) assert.match(after.output, new RegExp(`${name} behaves`));
    assert.deepEqual(f.user(), before, "the user's checkout is untouched");
  },
);
