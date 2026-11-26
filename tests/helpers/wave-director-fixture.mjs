import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Engine } from '../../runtime/engine.mjs';
import { Store } from '../../runtime/store.mjs';
import * as A from '../../runtime/project-contracts.mjs';
import { openProjectStore } from '../../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../../runtime/project-director.mjs';
import { confirmedCriteria } from './gate-review.mjs';

// Wave execution through the real Engine with fake subscription providers, a real
// temporary Git repository and the production transition authorizer.
// Every case of this file has one limit, { timeout: 900000 } (stage 16E). On Windows CI single cases took up to
// 278 s on passing runs ("Tasks with overlapping write paths never share a wave", run 45645526524), and the
// former 300 s limit stopped "Three disjoint tasks run in parallel…" (runs 45605431480, 45652087454), "Tasks
// with overlapping write paths…" (45630500497, 45652087454), "appendMilestone reopens…" (45605431480,
// 45630500497) and "drain replaces a gate reservation…" (45652087454) on slow runners. See docs/CI.md.
export const wave = { cadence: 'wave', integration: 'branch' };
export const proof = id => ({ id, text: 'The observable wave requirement holds.', evidenceKinds: ['acceptance'] });
export const task = (id, overrides = {}) => ({
  id,
  epicId: 'e1',
  title: `Task ${id}`,
  description: `Implement task ${id}.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`${id}.txt`],
  acceptance: [proof(`${id}-proof`)],
  interfaceRefs: [],
  priority: 50,
  userValue: 1,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...overrides,
});
export const done = id => ({
  sessionId: `worker-${id}`,
  output: { summary: `${id} done`, checks: ['written'], complete: true },
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
];

export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Fake subscription clients: a planner per task, workers writing the task file, reviews and repairs. */
function providers(fileOf, hooks) {
  const calls = { planner: [], worker: [], repair: [], review: 0, analysis: 0, active: 0, maxActive: 0 };
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
                writePaths: [fileOf(id)],
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
        calls.review++;
        if (hooks.onReview) await hooks.onReview(request, calls);
        return {
          sessionId: `review-${calls.review}`,
          output: { passed: true, findings: [], ...confirmedCriteria(request.schema) },
        };
      }
      if (/Repair confirmed failures/.test(request.prompt)) {
        calls.repair.push(request);
        await hooks.onRepair?.(request, calls);
        return done('repair');
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      calls.worker.push(id);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        await hooks.onWorker?.(request, id, calls);
        const file = path.join(request.cwd, fileOf(id));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${id} implemented\n`);
      } finally {
        calls.active--;
      }
      request.onEvent?.({ sessionId: `worker-${id}` });
      return done(id);
    },
  };
  const delivery = {
    deliver: async () => assert.fail('A wave task never delivers'),
    releasePackage: async () => assert.fail('A wave task never releases'),
  };
  return {
    calls,
    services: { provider, researcher: async () => ({ items: [], requests: 1, errors: [], cache: [] }), delivery },
  };
}

export async function fixture(
  t,
  {
    tasks = [task('alpha'), task('beta'), task('gamma')],
    config = {},
    failTogether = [],
    files = {},
    execution = wave,
    hooks = {},
    wrapRepo = repo => repo,
    evaluator,
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-director-'));
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home'),
    flag = path.join(directory, 'combined-fails.flag');
  await mkdir(root);
  await mkdir(isolated);
  await writeFile(path.join(isolated, 'gitconfig'), '');
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: isolated,
    USERPROFILE: isolated,
    KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
    KODO_WORKTREE_HOME: path.join(directory, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
  const stores = new Set();
  t.after(async () => {
    for (const store of stores) store.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-wave-director-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      client: 'codex',
      executionMode: 'quick',
      maxTasks: 2,
      concurrency: 1,
      researchBudget: 0,
      repairRounds: 1,
      commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
      delivery: { enabled: false, release: false },
      uiVerification: { enabled: false },
      security: { enabled: false },
      architecture: { enabled: false },
      ...config,
    }),
  );
  // Each task passes alone; the combined result fails while the flag exists.
  await writeFile(
    path.join(root, 'check.mjs'),
    `import { existsSync } from 'node:fs';\nconst together = ${JSON.stringify(failTogether)};\n` +
      `if (together.length && together.every(name => existsSync(name)) && existsSync(${JSON.stringify(flag)})) {\n` +
      `  console.error('combined behaviour fails');\n  process.exit(1);\n}\n`,
  );
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Wave Test');
  git(root, 'config', 'user.email', 'kodo-wave@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Wave fixture baseline');
  const store = new Store(home, {});
  stores.add(store);
  const fileOf = id => files[id] ?? `${id}.txt`;
  const { calls, services } = providers(fileOf, hooks);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A, evaluator }),
  });
  const epicIds = [...new Set(tasks.map(row => row.epicId))];
  const spec = {
    schemaVersion: 1,
    id: 'wave',
    root,
    title: 'Wave fixture',
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline wave fixture.',
    architectureRefs: [],
    milestones: [{ id: 'm1', title: 'Milestone', acceptance: [proof('m1-proof')], releaseRequired: false }],
    epics: epicIds.map(id => ({ id, milestoneId: 'm1', title: `Epic ${id}`, acceptance: [proof(`${id}-proof`)] })),
    tasks,
    ...(execution ? { execution } : {}),
  };
  const command = (snapshot, action) => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: snapshot?.project.projectId ?? null,
    expectedRevision: snapshot?.revision ?? null,
    actor: 'wave-test',
    reason: 'Observe the wave requirement',
    action,
  });
  const id = (await repo.apply(command(null, { op: 'create', spec }))).projectId;
  const director = createProjectDirector({ repo: wrapRepo(repo), engine });
  const user = () => ({
    head: git(root, 'rev-parse', 'HEAD'),
    branch: git(root, 'branch', '--show-current'),
    status: git(root, 'status', '--porcelain=v1'),
  });
  const merges = () =>
    git(root, 'log', '--first-parent', '--merges', '--format=%s', `refs/heads/kodo/project/${id}`)
      .split('\n')
      .filter(Boolean);
  const runs = () => store.listRuns(root);
  const branch = `refs/heads/kodo/project/${id}`;
  const branchHead = () => git(root, 'rev-parse', branch);
  // The private integration worktree of the project branch (another writer commits there).
  const integrationWorktree = () =>
    git(root, 'worktree', 'list', '--porcelain')
      .split(/\r?\n\r?\n/)
      .find(block => block.includes(`branch ${branch}`))
      .split(/\r?\n/)[0]
      .slice('worktree '.length);
  const commitOnBranch = async (name, text) => {
    const worktree = integrationWorktree();
    await writeFile(path.join(worktree, name), text);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-m', `Another writer adds ${name}`);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  return {
    directory,
    root,
    home,
    flag,
    store,
    engine,
    repo,
    id,
    director,
    calls,
    command,
    user,
    merges,
    runs,
    branchHead,
    integrationWorktree,
    commitOnBranch,
  };
}

export const statuses = rows => Object.fromEntries(rows.map(row => [row.id ?? row.taskId, row.status]));

export const reviewProfile = workers => ({
  subscriptions: [{ id: 'p', provider: 'codex', model: 'gpt', tier: 'standard', slots: workers }],
  machines: [{ id: 'pc', kind: 'local', maxWorkers: workers, maxHeavyBuilds: 1 }],
});
export async function reserveFixtureAttempts(f, ids) {
  for (const id of ids) {
    await f.repo.apply(
      f.command(f.repo.snapshot(f.id), { op: 'transition', kind: 'task', id, to: 'ready', evidence: [], mappings: [] }),
    );
    await f.repo.apply({
      ...f.command(f.repo.snapshot(f.id), { op: 'reserveAttempt', taskId: id, retryFailed: false }),
      actor: id.startsWith('n-') ? 'project-director' : 'project-external:t3',
    });
  }
}

export function placeExternalRuns(f, tasks, subscription) {
  const ids = new Set(
    f.repo
      .snapshot(f.id)
      .currentAttempts.filter(a => tasks.includes(a.taskId))
      .map(a => a.runId),
  );
  const getRun = f.store.getRun.bind(f.store);
  f.store.getRun = id =>
    ids.has(id)
      ? {
          executor: { kind: 'external', host: 't3' },
          workerPlacement: { subscription: { id: subscription }, machine: { id: 'pc' } },
        }
      : getRun(id);
}
