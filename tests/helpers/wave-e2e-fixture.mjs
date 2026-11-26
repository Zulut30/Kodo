import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Engine } from '../../runtime/engine.mjs';
import { Store } from '../../runtime/store.mjs';
import * as A from '../../runtime/project-contracts.mjs';
import { openProjectStore } from '../../runtime/project-store.mjs';
import { createProjectTransitionAuthorizer } from '../../runtime/project-director.mjs';
import { projectCli } from '../../runtime/project-cli.mjs';
import { withIntegrationLease } from '../../runtime/project-integration-lease.mjs';
import { confirmedCriteria } from './gate-review.mjs';

// End to end without fake ports: the real Store, project store, production
// authorizer, Engine (fake subscription providers only), wave director, pull
// protocol and CLI over a temporary Git repository.
// Every case of this file has one limit, { timeout: 900000 } (stage 16E). On slow Windows CI runners
// "drain accepts two epics…" took 497 s of the former 600 s limit (run 45605431480) and 428 s (run
// 45652087454). See docs/CI.md.
export const wave = { cadence: 'wave', integration: 'branch' };
export const proof = id => ({ id, text: 'The observable wave requirement holds.', evidenceKinds: ['acceptance'] });
export const task = (id, overrides = {}) => ({
  id,
  epicId: 'e1',
  title: `Task ${id}`,
  description: `Create ${id}.txt.`,
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

/** Fake subscription clients: a planner per task, workers writing `<id>.txt`, reviews and repairs. */
function providers(hooks) {
  const calls = { worker: [], repair: [], review: 0, reviews: [], active: 0, maxActive: 0 };
  const provider = {
    assessTask: async () => {
      throw Object.assign(new Error('Offline assessment'), { code: 'unavailable' });
    },
    analyzeGemini: async () => ({ summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] }),
    discoverProviders: async () => [{ id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }],
    decideJev: async () => ({ model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' }),
    runSession: async request => {
      if (request.schema?.properties?.tasks) {
        const id = /"taskId":"([a-z][a-z0-9-]*)"/.exec(request.prompt)[1];
        return {
          sessionId: `planner-${id}`,
          output: {
            summary: `Implement ${id}`,
            tasks: [
              {
                id: 'implementation',
                role: 'developer',
                writePaths: hooks.writePaths?.[id] ?? [`${id}.txt`],
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
        calls.reviews.push(request);
        return {
          sessionId: `review-${calls.review}`,
          output: (await hooks.onReview?.(request)) ?? {
            passed: true,
            findings: [],
            ...confirmedCriteria(request.schema),
          },
        };
      }
      if (/Repair confirmed failures/.test(request.prompt)) {
        calls.repair.push(request.cwd);
        await hooks.onRepair?.(request);
        return done('repair');
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      calls.worker.push(id);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        await hooks.onWorker?.(id, calls, request);
        await writeFile(path.join(request.cwd, `${id}.txt`), `${id} implemented\n`);
      } finally {
        calls.active--;
      }
      request.onEvent?.({ sessionId: `worker-${id}` });
      return done(id);
    },
  };
  const delivery = {
    deliver: async () => assert.fail('A wave project never delivers'),
    releasePackage: async () => assert.fail('A wave project never releases'),
  };
  return {
    calls,
    services: { provider, researcher: async () => ({ items: [], requests: 1, errors: [], cache: [] }), delivery },
  };
}

// The combined result fails while left.txt and right.txt both exist and left.txt is not fixed.
const check =
  "import { existsSync, readFileSync } from 'node:fs';\n" +
  "if (existsSync('left.txt') && existsSync('right.txt') && !readFileSync('left.txt', 'utf8').includes('fixed')) {\n" +
  "  console.error('left and right disagree');\n  process.exit(1);\n}\n";

export async function fixture(
  t,
  {
    epics,
    tasks,
    hooks = {},
    epicAcceptance = {},
    milestoneAcceptance = proof('m1-proof'),
    configure = config => config,
    files = {},
  },
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-e2e-'));
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home');
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
    assert.match(path.basename(directory), /^kodo-wave-e2e-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify(
      configure({
        schemaVersion: 1,
        client: 'codex',
        // Task Runs are always quick; the gate takes this mode (repairs need a re-verification round).
        executionMode: 'standard',
        maxTasks: 2,
        concurrency: 1,
        researchBudget: 0,
        repairRounds: 3,
        commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke: [] },
        delivery: { enabled: false, release: false },
        uiVerification: { enabled: false },
        security: { enabled: false },
        architecture: { enabled: false },
      }),
    ),
  );
  await writeFile(path.join(root, 'check.mjs'), check);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Wave E2E');
  git(root, 'config', 'user.email', 'kodo-wave-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Wave E2E baseline');
  const store = new Store(home, {});
  stores.add(store);
  const { calls, services } = providers(hooks);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A }),
  });
  const command = (snapshot, action, actor = 'wave-e2e') => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: snapshot?.project.projectId ?? null,
    expectedRevision: snapshot?.revision ?? null,
    actor,
    reason: 'Observe the wave requirement',
    action,
  });
  const spec = {
    schemaVersion: 1,
    id: 'wave-e2e',
    root,
    title: 'Wave end to end',
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline wave fixture.',
    architectureRefs: [],
    milestones: [{ id: 'm1', title: 'Milestone', acceptance: [milestoneAcceptance], releaseRequired: false }],
    epics: epics.map(id => ({
      id,
      milestoneId: 'm1',
      title: `Epic ${id}`,
      acceptance: [epicAcceptance[id] ?? proof(`${id}-proof`)],
    })),
    tasks,
    execution: wave,
  };
  const id = (await repo.apply(command(null, { op: 'create', spec }))).projectId;
  // CLI composition over the same Store and Engine (the CLI never closes a passed Store).
  const cli = argv => projectCli([...argv, '--json'], { secrets: {}, store, createEngine: () => engine });
  const branchHead = () => git(root, 'rev-parse', `refs/heads/kodo/project/${id}`);
  const statuses = rows => Object.fromEntries(rows.map(row => [row.id, row.status]));
  const taskRuns = () => store.listRuns(root).filter(run => run.directorBinding?.kind !== 'gate');
  return { root, store, engine, repo, id, command, calls, cli, branchHead, statuses, taskRuns };
}

export const editConfig = async (cwd, change) => {
  const file = path.join(cwd, 'kodo.config.json');
  await writeFile(file, JSON.stringify(change(JSON.parse(await readFile(file, 'utf8'))), null, 2));
};

// The production authorizer of an acceptance by the gate Run, with an evaluator that only runs its
// trusted validator (validateWaveRun), so the validator's own refusal code is observable.
export function authorizeByGate(f, run) {
  const authorize = createProjectTransitionAuthorizer({
    store: f.store,
    engine: f.engine,
    contracts: A,
    evaluator: {
      evaluateWaveTransition: async (input, ports) => {
        await ports.validateRun(input.run);
        return { eligibleStates: [input.command.action.to] };
      },
    },
  });
  const snapshot = f.repo.snapshot(f.id);
  const ref = {
    kind: 'checks',
    runId: run.id,
    headSha: run.headSha,
    path: run.gateManifest.path,
    sha256: 'a'.repeat(64),
  };
  const command = f.command(snapshot, {
    op: 'transition',
    kind: 'epic',
    id: 'e1',
    to: 'accepted',
    evidence: [ref],
    mappings: [],
  });
  return withIntegrationLease(f.store, f.id, () => authorize({ command, snapshot }));
}

// The default commands.test (`npm test`) whose package script is a plain `node --test`.
export const defaultNpmTest = async (cwd, scripts = { test: 'node --test' }) => {
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'wave', private: true, scripts }, null, 2));
  await editConfig(cwd, ({ commands: _, ...config }) => config);
};

// The production authorizer of a task transition with an evaluator that only runs the trusted
// validator (validateWaveRun) of the task Run, so its own refusal code is observable.
export function authorizeTask(f, run) {
  const authorize = createProjectTransitionAuthorizer({
    store: f.store,
    engine: f.engine,
    contracts: A,
    evaluator: {
      evaluateWaveTransition: async (input, ports) => {
        await ports.validateRun(input.run);
        return { eligibleStates: [input.command.action.to] };
      },
    },
  });
  const snapshot = f.repo.snapshot(f.id);
  const ref = {
    kind: 'checks',
    runId: run.id,
    headSha: run.headSha,
    path: run.checks.results[0].outputPath,
    sha256: 'a'.repeat(64),
  };
  const command = f.command(snapshot, {
    op: 'transition',
    kind: 'task',
    id: run.directorBinding.taskId,
    to: 'verifying',
    evidence: [ref],
    mappings: [],
  });
  return withIntegrationLease(f.store, f.id, () => authorize({ command, snapshot }));
}
export const withoutCommands = ({ commands: _, ...config }) => config;
export const npmManifest = JSON.stringify({ name: 'wave', private: true, scripts: { test: 'node --test' } });

export async function editWorker(brief, file, content) {
  await writeFile(path.join(brief.worktree, file), content);
  git(brief.worktree, 'add', '-A');
  git(brief.worktree, 'commit', '-m', 'Implement ' + brief.taskId);
  return git(brief.worktree, 'rev-parse', 'HEAD');
}
