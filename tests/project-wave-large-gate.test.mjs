import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Engine } from '../runtime/engine.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { ensureIntegration } from '../runtime/project-integration.mjs';
import { createGateRunDraft } from '../runtime/wave-verifier.mjs';
import { fixture, fakeServices, git } from './helpers/engine-fixture.mjs';

// Review finding F1-4: a project gate serialized the full contracts of every covered task into
// its 64 KiB Run text, so 240 short tasks in 24 epics ended in project_gate_too_large and the
// project never got its final gate. The contracts now live in the gate manifest artifact.
const EPICS = 24,
  PER_EPIC = 10;
const criterion = { id: 'works', text: 'The observable task result works.', evidenceKinds: ['checks'] };
const proof = {
  evidence: [
    { kind: 'checks', runId: null, headSha: null, path: '/srv/kodo-evidence/checks.json', sha256: 'a'.repeat(64) },
  ],
  mappings: [
    { criterionId: 'works', refs: ['a'.repeat(64)], actor: 'reviewer', reason: 'An earlier gate verified it' },
  ],
};
const taskSpec = (epic, index) => ({
  id: `t${epic}-${index}`,
  epicId: `e${epic}`,
  title: `Task ${epic}.${index}`,
  description: `Create the short file of task ${epic}.${index}.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`src/t${epic}-${index}.txt`],
  acceptance: [criterion],
  interfaceRefs: [],
  priority: 50,
  userValue: 1,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
});

// One `git fast-import` builds the integration history: per task a commit on the current
// head and its `--no-ff` merge back (first parent: the head before, second: the task commit).
function importHistory(root, base, tasks) {
  const lines = [];
  const data = text => `data ${Buffer.byteLength(text)}\n${text}\n`;
  tasks.forEach((task, i) => {
    const from = i === 0 ? base : `:${2 * i}`,
      file = `M 100644 inline ${task.writePaths[0]}\n${data(`${task.id} implemented`)}`;
    const commit = (mark, message, extra) =>
      `commit refs/kodo/large-import\nmark :${mark}\ncommitter Kodo Large <kodo-large@example.invalid> ${1700000000 + mark} +0000\n` +
      `${data(message)}from ${from}\n${extra}${file}`;
    lines.push(
      commit(2 * i + 1, `Implement ${task.id}`, ''),
      commit(2 * i + 2, `Kodo: integrate ${task.id}`, `merge :${2 * i + 1}\n`),
    );
  });
  const marks = path.join(root, '.git', 'large-import.marks');
  const result = spawnSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], {
    cwd: root,
    input: lines.join(''),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return marks;
}

test('240 tasks in 24 epics reach the install of the project gate; the manifest artifact carries every contract', async t => {
  const fx = await fixture(t, {
    config: {
      commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [], deploy: [], smoke: [] },
    },
    testScript: 'process.exit(0);\n',
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...fakeServices() });
  const repo = await openProjectStore({ store, contracts, authorizeTransition: async () => undefined });
  const tasks = Array.from({ length: EPICS * PER_EPIC }, (_, i) => taskSpec(Math.floor(i / PER_EPIC), i % PER_EPIC));
  const command = (projectId, action) => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId,
    expectedRevision: projectId ? repo.snapshot(projectId).revision : null,
    actor: 'coordinator',
    reason: 'Large wave project',
    action,
  });
  const { projectId } = await repo.apply(
    command(null, {
      op: 'create',
      spec: {
        schemaVersion: 1,
        id: 'large-wave',
        root: fx.project,
        title: 'Large wave project',
        definitionOfDone: [criterion],
        constraints: ['Only the assigned files.'],
        businessContext: 'Owned large fixture.',
        architectureRefs: [],
        milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
        epics: Array.from({ length: EPICS }, (_, e) => ({
          id: `e${e}`,
          milestoneId: 'm',
          title: `Epic ${e}`,
          acceptance: [criterion],
        })),
        tasks,
        execution: { cadence: 'wave', integration: 'branch' },
      },
    }),
  );
  const integration = await ensureIntegration({
    root: fx.project,
    projectId,
    worktreeHome: path.join(fx.directory, 'integration-home'),
  });
  const base = integration.head;
  const marks = Object.fromEntries(
    (await readFile(importHistory(fx.project, base, tasks), 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.split(' ')),
  );
  const tip = marks[`:${2 * tasks.length}`];
  git(integration.worktree, 'merge', '--ff-only', tip);

  // The state an earlier run of 23 epic gates leaves: their epics and tasks accepted, the last
  // epic's tasks integrated, every attempt's task Run recording its merge. (Driving ~2,500
  // transitions through the store would take minutes; the records are written as the store
  // writes them.)
  const now = new Date().toISOString(),
    merges = [],
    created = repo.snapshot(projectId);
  const update = store.db.prepare('UPDATE kodo_project_records SET body=? WHERE project_id=? AND kind=? AND id=?');
  const promote = (kind, id, status) => {
    const row = store.db
      .prepare('SELECT body FROM kodo_project_records WHERE project_id=? AND kind=? AND id=?')
      .get(projectId, kind, id);
    const record = { ...JSON.parse(row.body), status, updatedAt: now, ...(status === 'accepted' ? proof : {}) };
    update.run(JSON.stringify(record), projectId, kind, id);
  };
  store.db.exec('BEGIN IMMEDIATE');
  tasks.forEach((task, i) => {
    const status = task.epicId === `e${EPICS - 1}` ? 'integrated' : 'accepted';
    const attemptId = randomUUID(),
      runId = randomUUID(),
      before = i === 0 ? base : marks[`:${2 * i}`];
    const head = marks[`:${2 * i + 1}`],
      mergeCommit = marks[`:${2 * i + 2}`];
    const attempt = {
      schemaVersion: 1,
      id: attemptId,
      projectId,
      taskId: task.id,
      taskRevision: 1,
      number: 1,
      runId,
      contractHash: contracts.directorContractHash(
        created.tasks.find(row => row.id === task.id),
        { knownValues: [] },
      ),
      status,
      baseSha: null,
      headSha: null,
      evidence: status === 'accepted' ? proof.evidence : [],
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    store.db
      .prepare(
        'INSERT INTO kodo_project_attempts(id,project_id,task_id,number,run_id,installed,body) VALUES(?,?,?,?,?,1,?)',
      )
      .run(attemptId, projectId, task.id, 1, runId, JSON.stringify(attempt));
    store.db.prepare('INSERT INTO kodo_project_current VALUES(?,?,?)').run(projectId, task.id, attemptId);
    promote('task', task.id, status);
    store.createRun({
      id: runId,
      project: fx.project,
      headSha: head,
      integration: { branch: integration.branch, before, mergeCommit, mergedHead: head, status: 'merged' },
    });
    merges.push({ taskId: task.id, attemptId, runId, mergeCommit });
  });
  for (let e = 0; e < EPICS - 1; e++) promote('epic', `e${e}`, 'accepted');
  promote('epic', `e${EPICS - 1}`, 'integrated');
  store.db.exec('COMMIT');

  const snapshot = repo.snapshot(projectId);
  assert.equal(snapshot.tasks.length, 240);
  assert.equal(snapshot.epics.filter(row => row.status === 'accepted').length, 23);
  // The base is the first parent of the earliest covered merge: the head before the first task merge.
  const baseSha = base;
  const containers = [
    { kind: 'epic', id: `e${EPICS - 1}` },
    { kind: 'milestone', id: 'm' },
    { kind: 'project', id: projectId },
  ];
  await repo.apply(command(projectId, { op: 'reserveGate', containers, baseSha, headSha: tip, merges, retry: false }));
  const [gate] = repo.snapshot(projectId).gates;
  const run = await createGateRunDraft({
    engine,
    project: repo.snapshot(projectId).project,
    gate,
    tasks: repo.snapshot(projectId).tasks,
    containers: contracts.gateContainerCriteria(repo.snapshot(projectId), gate),
    installGateRun: repo.installGateRun,
    leaseHeld: true,
  });
  const installed = repo.snapshot(projectId);
  assert.equal(installed.gates[0].installed, true, 'the project gate is installed');
  assert.deepEqual(store.getRun(gate.runId), run);
  assert.deepEqual(run.directorBinding, contracts.gateBindingFor(gate));
  assert.equal(run.plan.tasks.length, 240);
  // The Run text is a compact summary bound to the manifest artifact by its hash.
  assert.ok(Buffer.byteLength(run.task) < 2048, `${Buffer.byteLength(run.task)} bytes of Run text`);
  const summary = JSON.parse(run.task.slice(run.task.indexOf('\n') + 1));
  const manifest = contracts.buildGateManifest({
    project: installed.project,
    gate,
    tasks: installed.tasks,
    containers: contracts.gateContainerCriteria(installed, gate),
  });
  assert.equal(summary.taskCount, 240);
  assert.ok(
    manifest.bytes > 64 * 1024,
    `the covered contracts take ${manifest.bytes} bytes, over the old 64 KiB Run text`,
  );
  assert.deepEqual(summary.gate, { containers, baseSha: base, headSha: tip });
  assert.deepEqual(summary.manifest, { kind: 'gate-manifest', sha256: manifest.sha256, bytes: manifest.bytes });
  await engine.assertEvidence(run.gateManifest);
  assert.equal(path.dirname(run.gateManifest.path), path.join(run.artifacts, 'evidence'));
  const envelope = JSON.parse(await readFile(run.gateManifest.path, 'utf8'));
  assert.equal(envelope.kind, 'gate-manifest');
  assert.deepEqual(envelope.value, manifest.manifest, 'every covered contract, in merge order');
  assert.deepEqual(
    envelope.value.tasks.map(row => row.taskId),
    tasks.map(row => row.id),
  );
});
