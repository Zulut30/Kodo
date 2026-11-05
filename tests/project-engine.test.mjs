import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../runtime/engine.mjs';
import { fixture as engineFixture } from './helpers/engine-fixture.mjs';

async function fixture(t) {
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'kodo-project-engine-home-'));
  const variables = { HOME: isolated, USERPROFILE: isolated, KODO_HOME: path.join(isolated, 'state'),
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'), KODO_WORKTREE_HOME: path.join(isolated, 'worktrees'),
    GIT_CONFIG_GLOBAL: path.join(isolated, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(path.dirname(isolated), path.resolve(os.tmpdir())); assert.match(path.basename(isolated), /^kodo-project-engine-home-/);
    await rm(isolated, { recursive: true, force: true });
  });
  return engineFixture(t);
}

test('Reserved creation initializes exact identity before one atomic installer and never inserts early', async t => {
  const f = await fixture(t), store = f.openStore(), engine = new Engine({ store, secrets: {} });
  const binding = { schemaVersion: 1, projectId: randomUUID(), taskId: 'owned-task', taskRevision: 1,
    attemptId: randomUUID(), runId: randomUUID(), contractHash: 'a'.repeat(64) };
  let installs = 0;
  const task = 'Project reference: use both subscriptions. Implement only the assigned file.';
  const run = await engine.createReserved(task, { project: f.project, mode: 'quick', model: 'gpt-6.1-sol' }, {
    binding, installRun: async ({ binding: actual, runDraft }) => {
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
    }
  });
  assert.equal(installs, 1); assert.equal(run.id, binding.runId);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});

test('Legacy create retains phrase routing while reserved creation rejects redaction and failed install leaves no Run', async t => {
  const f = await fixture(t), store = f.openStore(), engine = new Engine({ store, secrets: {} });
  const legacy = await engine.create('use both subscriptions', { project: f.project });
  assert.equal(legacy.providers, 'both');
  const binding = { schemaVersion: 1, projectId: randomUUID(), taskId: 'owned-task', taskRevision: 1,
    attemptId: randomUUID(), runId: randomUUID(), contractHash: 'a'.repeat(64) };
  let installs = 0;
  await assert.rejects(() => engine.createReserved('Bearer owned-literal-credential', { project: f.project }, {
    binding, installRun: async () => { installs++; }
  }));
  assert.equal(installs, 0);
  await assert.rejects(() => engine.createReserved('Owned task', { project: f.project }, {
    binding, installRun: async () => { installs++; throw Error('owned install interruption'); }
  }), /owned install interruption/);
  assert.throws(() => store.getRun(binding.runId)); assert.equal(installs, 1);
});
