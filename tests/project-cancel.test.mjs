import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector } from '../runtime/project-director.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-project-cancel-'));
  const root = path.join(directory, 'project'),
    home = path.join(directory, 'state');
  await mkdir(root);
  let store, repo, director, id;
  const forwarded = [];
  const open = async () => {
    store = new Store(home, {});
    repo = await openProjectStore({ store, contracts });
    director = createProjectDirector({
      repo,
      engine: {
        store,
        secrets: {},
        cancel: async runId => {
          assert.equal(repo.snapshot(id).project.status, 'cancelled');
          assert.equal(store.getRun(runId).cancelRequested, true);
          assert.equal(store.getRun(runId).directorBinding.attemptId, repo.snapshot(id).currentAttempts[0].id);
          forwarded.push(runId);
        },
      },
    });
  };
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^kodo-project-cancel-/);
    await rm(directory, { recursive: true, force: true });
  });
  await open();
  const apply = action =>
    repo.apply({
      schemaVersion: 1,
      projectId: id ?? null,
      expectedRevision: id ? repo.snapshot(id).revision : null,
      commandId: randomUUID(),
      actor: 'owned-cancel-test',
      reason: 'Observe public cancellation and immutable history.',
      action,
    });
  const criterion = { id: 'works', text: 'Assigned observable behavior works.', evidenceKinds: ['checks'] };
  id = (
    await apply({
      op: 'create',
      spec: {
        schemaVersion: 1,
        id: 'owned',
        root,
        title: 'Owned cancellation',
        definitionOfDone: [criterion],
        constraints: ['Only assigned work.'],
        businessContext: 'Offline cancellation fixture.',
        architectureRefs: [],
        milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
        epics: [{ id: 'e', milestoneId: 'm', title: 'Epic', acceptance: [criterion] }],
        tasks: [
          {
            id: 'task',
            epicId: 'e',
            title: 'Task',
            description: 'Deliver observable behavior.',
            owner: 'developer',
            dependsOn: [],
            writePaths: ['runtime/example.mjs'],
            acceptance: [criterion],
            interfaceRefs: [],
            priority: 50,
            userValue: 1,
            risk: 1,
            estimatedEffort: 1,
            riskApprovalRequired: false,
          },
        ],
      },
    })
  ).projectId;
  const { attempt } = await apply({ op: 'reserveAttempt', taskId: 'task', retryFailed: false });
  const snapshot = repo.snapshot(id),
    binding = {
      schemaVersion: 1,
      projectId: id,
      taskId: attempt.taskId,
      taskRevision: attempt.taskRevision,
      attemptId: attempt.id,
      runId: attempt.runId,
      contractHash: attempt.contractHash,
    };
  await repo.installRun({
    binding,
    runDraft: {
      id: attempt.runId,
      project: root,
      task: contracts.buildDirectorTaskInput(
        { project: snapshot.project, task: snapshot.tasks[0] },
        { knownValues: [] },
      ),
      createdAt: new Date().toISOString(),
      state: 'created',
      completed: {},
      nodes: {},
      config: { client: 'codex' },
      client: 'codex',
      providers: 'current',
      baseSha: 'a'.repeat(40),
      snapshot: { root, head: 'a'.repeat(40) },
      requestedMode: 'quick',
      sessionAttempts: [],
      coordinatorOperations: [],
      artifacts: path.join(root, 'artifacts'),
      worktreeRoot: path.join(root, 'worktrees'),
      cwd: path.join(root, 'worktrees', 'integration'),
      branch: 'kodo/cancel-fixture',
      directorBinding: binding,
    },
  });
  const unrelated = store.createRun({ id: randomUUID(), project: root, task: 'Unrelated legacy Run' });
  return {
    id,
    attempt,
    apply,
    forwarded,
    unrelated,
    directory,
    get store() {
      return store;
    },
    get repo() {
      return repo;
    },
    get director() {
      return director;
    },
    async reopen() {
      store.close();
      await open();
    },
  };
}

for (const status of ['blocked', 'failed', 'cancelled']) {
  test(`Director cancel preserves stale ${status} Attempt and forwards the owned Run before and after SQLite reopen`, async t => {
    const f = await fixture(t),
      body = `Owned ${status} observation\n`,
      filename = path.join(f.directory, 'observation.txt');
    await writeFile(filename, body);
    const evidence = [
      {
        kind: 'checks',
        runId: f.attempt.runId,
        headSha: null,
        path: filename,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    ];
    await f.apply({ op: 'transition', kind: 'attempt', id: f.attempt.id, to: status, evidence, mappings: [] });
    f.store.updateRun(f.attempt.runId, { state: status });
    const original = f.repo.snapshot(f.id).currentAttempts[0];
    await f.director.reprioritize(f.id, 'task', { priority: 60 });
    assert.equal(f.repo.snapshot(f.id).tasks[0].revision, original.taskRevision + 1);
    const history = f.repo.history(f.id, { after: 0, limit: 1000 }).events;
    assert.deepEqual(await f.director.cancel(f.id), { status: 'cancelled' });
    const revision = f.repo.snapshot(f.id).revision;
    await f.reopen();
    assert.deepEqual(await f.director.cancel(f.id), { status: 'cancelled' });
    const after = f.repo.snapshot(f.id);
    assert.equal(after.project.status, 'cancelled');
    assert.equal(after.revision, revision, 'Repeated cancel must not rewrite history');
    assert.deepEqual(
      after.currentAttempts,
      [original],
      'Preserve status, taskRevision, contractHash, evidence and timestamps',
    );
    const events = f.repo.history(f.id, { after: 0, limit: 1000 }).events;
    assert.deepEqual(events.slice(0, history.length), history);
    assert.equal(events.length, history.length + 1, 'Only the Project cancellation adds an event');
    assert.deepEqual(f.forwarded, [f.attempt.runId, f.attempt.runId]);
    assert.deepEqual(f.store.getRun(f.unrelated.id), f.unrelated);
  });
}

test('Director cancel still cancels an active reserved Attempt and its owned installed Run', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.director.cancel(f.id), { status: 'cancelled' });
  assert.equal(f.repo.snapshot(f.id).currentAttempts[0].status, 'cancelled');
  assert.deepEqual(f.forwarded, [f.attempt.runId]);
  assert.deepEqual(f.store.getRun(f.unrelated.id), f.unrelated);
});
