import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../runtime/engine.mjs';
import { fixture as engineFixture, fakeServices, node } from './helpers/engine-fixture.mjs';
import { buildDirectorTaskInput, directorContractHash } from '../runtime/project-contracts.mjs';

async function fixture(t) {
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'kodo-project-engine-home-'));
  const variables = {
    HOME: isolated,
    USERPROFILE: isolated,
    KODO_HOME: path.join(isolated, 'state'),
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
    KODO_WORKTREE_HOME: path.join(isolated, 'worktrees'),
    GIT_CONFIG_GLOBAL: path.join(isolated, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.equal(path.dirname(isolated), path.resolve(os.tmpdir()));
    assert.match(path.basename(isolated), /^kodo-project-engine-home-/);
    await rm(isolated, { recursive: true, force: true });
  });
  return engineFixture(t);
}

test('Reserved creation initializes exact identity before one atomic installer and never inserts early', async t => {
  const f = await fixture(t),
    store = f.openStore(),
    engine = new Engine({ store, secrets: {} });
  const binding = {
    schemaVersion: 1,
    projectId: randomUUID(),
    taskId: 'owned-task',
    taskRevision: 1,
    attemptId: randomUUID(),
    runId: randomUUID(),
    contractHash: 'a'.repeat(64),
  };
  let installs = 0;
  const task = 'Project reference: use both subscriptions. Implement only the assigned file.';
  const run = await engine.createReserved(
    task,
    { project: f.project, mode: 'quick', model: 'gpt-6.1-sol' },
    {
      binding,
      installRun: async ({ binding: actual, runDraft }) => {
        installs++;
        assert.deepEqual(actual, binding);
        assert.throws(() => store.getRun(binding.runId));
        assert.equal(runDraft.id, binding.runId);
        assert.equal(runDraft.task, task);
        assert.equal(runDraft.providers, 'current');
        assert.equal(runDraft.requestedMode, 'quick');
        assert.equal(runDraft.fixedModel.model, 'gpt-6.1-sol');
        assert.ok(runDraft.artifacts.endsWith(binding.runId));
        assert.ok(runDraft.cwd.includes(binding.runId));
        return store.createRun(runDraft);
      },
    },
  );
  assert.equal(installs, 1);
  assert.equal(run.id, binding.runId);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('Legacy create retains phrase routing while reserved creation rejects redaction and failed install leaves no Run', async t => {
  const f = await fixture(t),
    store = f.openStore(),
    engine = new Engine({ store, secrets: {} });
  const legacy = await engine.create('use both subscriptions', { project: f.project });
  assert.equal(legacy.providers, 'both');
  const binding = {
    schemaVersion: 1,
    projectId: randomUUID(),
    taskId: 'owned-task',
    taskRevision: 1,
    attemptId: randomUUID(),
    runId: randomUUID(),
    contractHash: 'a'.repeat(64),
  };
  let installs = 0;
  await assert.rejects(() =>
    engine.createReserved(
      'Bearer owned-literal-credential',
      { project: f.project },
      {
        binding,
        installRun: async () => {
          installs++;
        },
      },
    ),
  );
  assert.equal(installs, 0);
  await assert.rejects(
    () =>
      engine.createReserved(
        'Owned task',
        { project: f.project },
        {
          binding,
          installRun: async () => {
            installs++;
            throw Error('owned install interruption');
          },
        },
      ),
    /owned install interruption/,
  );
  assert.throws(() => store.getRun(binding.runId));
  assert.equal(installs, 1);
});

test('A valid native child plan outside the frozen ProjectTask scope cannot start a worker or write a file', async t => {
  const f = await fixture(t),
    store = f.openStore();
  const plan = { summary: 'A schema-valid escaped plan', tasks: [node('escape', 'developer', ['unowned.txt'])] };
  const services = fakeServices({
    plan,
    onWorker: async request => {
      await writeFile(path.join(request.cwd, 'unowned.txt'), 'This worker must never start\n');
      return { sessionId: 'owned-escape', output: { summary: 'Escaped', complete: true, checks: [] } };
    },
  });
  const engine = new Engine({ store, secrets: {}, ...services });
  const projectId = randomUUID(),
    now = new Date().toISOString(),
    root = await realpath(f.project);
  const criterion = { id: 'owned-proof', text: 'Only src/value.mjs may change', evidenceKinds: ['acceptance'] };
  const meta = {
    schemaVersion: 1,
    projectId,
    revision: 1,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    evidence: [],
    mappings: [],
  };
  const project = {
    ...meta,
    id: 'owned-project',
    root,
    projectKey: process.platform === 'win32' ? root.toLowerCase() : root,
    title: 'Owned task boundary',
    definitionOfDone: [criterion],
    constraints: ['Only assigned file'],
    businessContext: '',
    architectureRefs: [],
    paused: false,
  };
  const task = {
    ...meta,
    id: 'owned-task',
    epicId: 'owned-epic',
    title: 'Update the value',
    description: 'Update the assigned value file',
    owner: 'developer',
    dependsOn: [],
    writePaths: ['src/value.mjs'],
    acceptance: [criterion],
    interfaceRefs: [],
    priority: 50,
    userValue: 1,
    risk: 1,
    estimatedEffort: 1,
    riskApprovalRequired: false,
  };
  const binding = {
    schemaVersion: 1,
    projectId,
    taskId: task.id,
    taskRevision: 1,
    attemptId: randomUUID(),
    runId: randomUUID(),
    contractHash: directorContractHash(task, { knownValues: [] }),
  };
  const run = await engine.createReserved(
    buildDirectorTaskInput({ project, task }, { knownValues: [] }),
    { project: f.project, mode: 'quick', model: 'gpt-6.1-sol' },
    { binding, installRun: async ({ runDraft }) => store.createRun(runDraft) },
  );
  const result = await engine.run(run.id);
  assert.equal(services.calls.planner, 1);
  assert.equal(services.calls.worker.length, 0);
  assert.equal(result.state, 'blocked');
  assert.equal(result.error.code, 'project_scope_violation');
  await assert.rejects(() => access(path.join(result.cwd, 'unowned.txt')));
  await assert.rejects(() => access(path.join(f.project, 'unowned.txt')));
});
