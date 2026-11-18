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
import { createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { projectCli } from '../runtime/project-cli.mjs';

// Project factory end to end through the CLI only: a file blueprint (Wave 0 and
// two parallel tasks) → apply-spec → drain → accepted; then extend --prepare →
// append-milestone → drain → accepted again. Real Store, project store,
// authorizer, Engine with fake subscription providers, temporary Git; no network.
const wave = { cadence: 'wave', integration: 'branch' };
const proof = id => ({ id, text: 'The observable factory requirement holds.', evidenceKinds: ['acceptance'] });
const task = (id, overrides = {}) => ({
  id,
  epicId: 'core',
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

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Fake subscription clients: a planner per task, workers writing `<id>.txt`, passing reviews. */
function providers() {
  const calls = { worker: [], review: 0, active: 0, maxActive: 0 };
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
                writePaths: [`${id}.txt`],
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
        return { sessionId: `review-${calls.review}`, output: { passed: true, findings: [] } };
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      calls.worker.push(id);
      calls.active++;
      calls.maxActive = Math.max(calls.maxActive, calls.active);
      try {
        // The parallel pair stays inside a session until the other one arrives.
        if (id === 'left' || id === 'right') for (let i = 0; i < 400 && calls.active < 2; i++) await delay(25);
        await writeFile(path.join(request.cwd, `${id}.txt`), `${id} implemented\n`);
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
  return {
    calls,
    services: { provider, researcher: async () => ({ items: [], requests: 1, errors: [], cache: [] }), delivery },
  };
}

const PROJECT = `# Фабрика: сквозной проект

## Цель

Проверить, что файловый чертёж исполняется волнами до приёмки.

## Модули

- foundation — общий каркас: base.txt.
- core — left.txt и right.txt по интерфейсу core.

## Стек

Node.js 24, ESM, node:test.

## Критерии готовности

Все задачи приняты гейтами эпиков, проект принят.
`;

/** The main chat's blueprint: Wave 0 (`foundation`) and two parallel core tasks. */
async function writeBlueprint(root) {
  const dir = path.join(root, '.kodo', 'blueprint');
  await mkdir(path.join(dir, 'interfaces'), { recursive: true });
  await writeFile(path.join(dir, 'PROJECT.md'), PROJECT);
  await writeFile(
    path.join(dir, 'interfaces', 'core.md'),
    '# core\n\nleft.txt и right.txt содержат `<id> implemented`.\n',
  );
  const spec = {
    schemaVersion: 1,
    id: 'factory-e2e',
    root,
    title: 'Factory end to end',
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline factory fixture.',
    architectureRefs: [],
    milestones: [{ id: 'm1', title: 'First milestone', acceptance: [proof('m1-proof')], releaseRequired: false }],
    epics: [
      { id: 'foundation', milestoneId: 'm1', title: 'Wave 0', acceptance: [proof('foundation-proof')] },
      { id: 'core', milestoneId: 'm1', title: 'Core', acceptance: [proof('core-proof')] },
    ],
    tasks: [
      task('base', { epicId: 'foundation', owner: 'architect' }),
      task('left', { dependsOn: ['base'], interfaceRefs: [{ kind: 'interface', path: 'interfaces/core.md' }] }),
      task('right', { dependsOn: ['base'] }),
    ],
    execution: wave,
  };
  await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-factory-e2e-'));
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
    assert.match(path.basename(directory), /^kodo-factory-e2e-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      client: 'codex',
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
  );
  await writeFile(path.join(root, 'check.mjs'), "console.log('factory check passed');\n");
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Factory E2E');
  git(root, 'config', 'user.email', 'kodo-factory-e2e@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Factory E2E baseline');
  const store = new Store(home, {});
  stores.add(store);
  const { calls, services } = providers();
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A }),
  });
  // One CLI composition over the same Store and Engine (the CLI never closes a passed Store).
  const cli = async argv => {
    const result = await projectCli([...argv, '--json'], {
      home,
      secrets: {},
      store,
      createEngine: () => engine,
      architecture: null,
      knowledge: null,
    });
    return { ...result, report: JSON.parse(result.output) };
  };
  return { root, store, repo, calls, cli };
}

const statuses = rows => Object.fromEntries(rows.map(row => [row.id, row.status]));
const containers = gate => gate.containers.map(row => `${row.kind}:${row.kind === 'project' ? '' : row.id}`);

test(
  'factory: apply-spec → drain accepts the blueprint, append-milestone → drain accepts the feature',
  { timeout: 600000 },
  async t => {
    const f = await fixture(t);
    await writeBlueprint(f.root);
    const user = git(f.root, 'rev-parse', 'HEAD');

    const applied = await f.cli(['apply-spec', '--root', f.root]);
    assert.equal(applied.exitCode, 0, applied.output);
    assert.equal(applied.report.result.status, 'created');
    assert.deepEqual(applied.report.result.execution, wave);
    assert.deepEqual(applied.report.result.modules.waveZero, ['base']);
    assert.deepEqual(
      applied.report.result.interfaces.map(item => item.module),
      ['core'],
    );
    const id = applied.report.projectId;
    const left = f.repo.snapshot(id).tasks.find(row => row.id === 'left');
    assert.equal(left.interfaceRefs.length, 1, 'the interface became a verifiable evidence Ref');

    const first = await f.cli(['drain', id, '--concurrency', '2']);
    assert.equal(first.exitCode, 0, first.output);
    assert.equal(first.report.result.status, 'accepted', first.output);
    assert.equal(first.report.result.waves, 2, 'wave 0 (base), then left and right together');
    assert.deepEqual([...first.report.result.integrated].sort(), ['base', 'left', 'right']);
    assert.equal(first.report.result.integrated[0], 'base');
    const closed = f.repo.snapshot(id);
    assert.equal(closed.project.status, 'accepted');
    assert.deepEqual(statuses(closed.milestones), { m1: 'accepted' });
    assert.deepEqual(statuses(closed.epics), { foundation: 'accepted', core: 'accepted' });
    assert.deepEqual(statuses(closed.tasks), { base: 'accepted', left: 'accepted', right: 'accepted' });
    const branch = () => git(f.root, 'rev-parse', `refs/heads/kodo/project/${id}`);
    const acceptedHead = branch();

    // A new feature: the prepared bundle receives the milestone the main chat wrote.
    const prepared = await f.cli(['extend', id, 'Добавить extra.txt', '--prepare']);
    assert.equal(prepared.exitCode, 0, prepared.output);
    assert.equal(prepared.report.result.status, 'prepared');
    const template = JSON.parse(await readFile(prepared.report.result.template, 'utf8'));
    assert.ok(template && typeof template === 'object');
    const file = path.join(prepared.report.result.bundle.dir, 'milestone.json');
    await writeFile(
      file,
      JSON.stringify({
        milestone: { id: 'm2', title: 'Feature', acceptance: [proof('m2-proof')], releaseRequired: false },
        epics: [{ id: 'feature', milestoneId: 'm2', title: 'Feature', acceptance: [proof('feature-proof')] }],
        tasks: [task('extra', { epicId: 'feature', dependsOn: ['left'] })],
      }),
    );
    const appended = await f.cli(['append-milestone', id, '--file', file]);
    assert.equal(appended.exitCode, 0, appended.output);
    assert.equal(appended.report.result.status, 'appended');
    assert.equal(appended.report.result.projectStatus, 'running');

    const second = await f.cli(['drain', id, '--concurrency', '2']);
    assert.equal(second.exitCode, 0, second.output);
    assert.equal(second.report.result.status, 'accepted', second.output);
    assert.deepEqual(second.report.result.integrated, ['extra']);
    assert.deepEqual(f.calls.worker.toSorted(), ['base', 'extra', 'left', 'right'], 'no task ran twice');
    assert.equal(f.calls.maxActive, 2, 'left and right overlapped in time');

    const reopened = f.repo.snapshot(id);
    assert.equal(reopened.project.status, 'accepted');
    assert.equal(reopened.project.reopened.length, 1);
    assert.deepEqual(statuses(reopened.milestones), { m1: 'accepted', m2: 'accepted' });
    assert.deepEqual(statuses(reopened.tasks), {
      base: 'accepted',
      left: 'accepted',
      right: 'accepted',
      extra: 'accepted',
    });
    for (const key of ['milestones', 'epics', 'tasks'])
      for (const row of closed[key])
        assert.deepEqual(
          reopened[key].find(item => item.id === row.id),
          row,
          `${key}:${row.id} is untouched by the new milestone`,
        );
    assert.deepEqual(
      reopened.gates.map(containers).slice(closed.gates.length),
      [['epic:feature', 'milestone:m2', 'project:']],
      'one gate for the new epic covers its milestone and the project',
    );
    const extraRun = f.store
      .listRuns(f.root)
      .find(run => run.directorBinding?.kind !== 'gate' && run.directorBinding?.taskId === 'extra');
    assert.equal(git(f.root, 'merge-base', '--is-ancestor', acceptedHead, extraRun.baseSha), '');
    for (const name of ['base', 'left', 'right', 'extra'])
      assert.equal(git(f.root, 'show', `${branch()}:${name}.txt`), `${name} implemented`);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), user, "the user's checkout is untouched");
  },
);
