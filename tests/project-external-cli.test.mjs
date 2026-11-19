import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectCli } from '../runtime/project-cli.mjs';
import { projectExternalCli } from '../runtime/project-cli-external.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const head = 'a'.repeat(40);

test('Invalid next-wave/complete-task arguments fail before credentials or state are opened', async () => {
  const cases = [
    ['next-wave'],
    ['next-wave', id],
    ['next-wave', id, '--host'],
    ['next-wave', id, '--host', 'codex'],
    ['next-wave', id, '--host', 'T3'],
    ['next-wave', id, '--host', 't3', '--limit', '0'],
    ['next-wave', id, '--host', 't3', '--limit', '6'],
    ['next-wave', id, '--host', 't3', '--limit', '1.5'],
    ['next-wave', id, '--host', 't3', '--limit', '03'],
    ['next-wave', id, '--host', 't3', '--host', 'orca'],
    ['next-wave', id, '--host', 't3', '--head', head],
    ['next-wave', id, '--host', 't3', '--command-id', id],
    ['next-wave', id, 'task-a', '--host', 't3'],
    ['next-wave', 'not-a-uuid', '--host', 't3'],
    ['next-wave', id, '--host=t3'],
    ['complete-task', id, 'task-a'],
    ['complete-task', id, '--head', head],
    ['complete-task', id, 'Task_A', '--head', head],
    ['complete-task', id, 'task-a', '--head', 'HEAD'],
    ['complete-task', id, 'task-a', '--head', head.slice(1)],
    ['complete-task', id, 'task-a', '--head', head, '--defer-gate', '--abandon'],
    ['complete-task', id, 'task-a', '--head', head, '--retry-failed'],
    ['complete-task', id, 'task-a', '--head', head, '--host', 't3'],
    ['complete-task', id, 'task-a', '--head', head, '--command-id', 'x'],
    ['complete-task', id, 'task-a', '--head', head, '--abandon', '--abandon'],
    ['complete-task', id, 'task-a', '--head', head, '\u0001'],
    ['gates'],
    ['gates', 'not-a-uuid'],
    ['gates', id, 'task-a'],
    ['gates', id, '--host', 't3'],
    ['gates', id, '--head', head],
    ['gates', id, '--limit', '1'],
    ['gates', id, '--retry-failed', '--retry-failed'],
    ['gates', id, '--defer-gate'],
  ];
  let calls = 0;
  const ports = {
    loadSecrets: () => {
      calls++;
      throw Error('Must parse first');
    },
    openStore: () => {
      calls++;
      throw Error('Must parse first');
    },
    wave: new Proxy(
      {},
      {
        get() {
          calls++;
          throw Error('Must parse first');
        },
      },
    ),
  };
  for (const args of cases)
    for (const cli of [projectCli, projectExternalCli]) {
      const result = await cli([...args, '--json'], ports);
      assert.equal(result.exitCode, 1, args.join(' '));
      assert.deepEqual(result.report, {
        schemaVersion: 1,
        projectId: null,
        revision: null,
        result: { status: 'invalid', code: 'project_arguments' },
      });
      assert.deepEqual(JSON.parse(result.output), result.report);
    }
  assert.equal(calls, 0);
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function project(t, temp, name, wave) {
  const root = path.join(temp, name);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/a.mjs'), 'export const a = 1;\n');
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      client: 'codex',
      baseBranch: 'main',
      commands: { test: [{ command: process.execPath, args: ['--test'] }], build: [], deploy: [], smoke: [] },
      delivery: { enabled: false, release: false },
    }),
  );
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo External CLI Test');
  git(root, 'config', 'user.email', 'kodo-external-cli@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Fixture baseline');
  const criterion = { id: 'works', text: 'Works', evidenceKinds: ['checks'] };
  const spec = {
    schemaVersion: 1,
    id: name,
    root,
    title: 'CLI ' + name,
    definitionOfDone: [criterion],
    constraints: [],
    businessContext: 'Owned fixture',
    architectureRefs: [],
    ...(wave ? { execution: { cadence: 'wave', integration: 'branch' } } : {}),
    milestones: [{ id: 'm', title: 'Milestone', acceptance: [criterion], releaseRequired: false }],
    epics: [{ id: 'e', milestoneId: 'm', title: 'Epic', acceptance: [criterion] }],
    tasks: [
      {
        id: 'task-a',
        epicId: 'e',
        title: 'Task a',
        description: 'Implement a',
        owner: 'architect',
        dependsOn: [],
        writePaths: ['src/a.mjs'],
        acceptance: [criterion],
        interfaceRefs: [],
        priority: 50,
        userValue: 3,
        risk: 1,
        estimatedEffort: 1,
        riskApprovalRequired: false,
      },
    ],
  };
  const file = path.join(temp, `${name}.json`);
  await writeFile(file, JSON.stringify(spec));
  return file;
}

test('Project CLI delegates next-wave and complete-task to the pull protocol', async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-external-cli-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'state');
  const base = { secrets: {}, home };
  const created = async name => {
    const result = await projectCli(
      ['create', '--file', await project(t, temp, name, name === 'wave'), '--json'],
      base,
    );
    assert.equal(result.exitCode, 0, result.output);
    return result.report.projectId;
  };
  const legacy = await created('legacy');
  const refused = await projectCli(['next-wave', legacy, '--host', 't3', '--json'], base);
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.report.result, { status: 'invalid', code: 'project_wave_required' });
  const noGates = await projectCli(['gates', legacy, '--json'], base);
  assert.equal(noGates.exitCode, 1);
  assert.deepEqual(noGates.report.result, { status: 'invalid', code: 'project_wave_required' });

  const waveId = await created('wave');
  const selected = [];
  const wave = {
    selectWave: (snapshot, options) => {
      selected.push(options);
      return snapshot.tasks.filter(task => task.status === 'proposed').map(task => task.id);
    },
  };
  const next = await projectCli(['next-wave', waveId, '--host', 'orca', '--limit', '2', '--json'], { ...base, wave });
  assert.equal(next.exitCode, 0, next.output);
  // Like drain, the selection sees which tasks have verified interface proofs.
  assert.deepEqual(
    selected.map(({ limit, inFlight, availability }) => ({
      limit,
      inFlight,
      availability: availability.map(row => [row.taskId, row.interfacesVerified]),
    })),
    [{ limit: 2, inFlight: [], availability: [['task-a', true]] }],
  );
  const gateCalls = [];
  const gatePorts = {
    ...wave,
    createWaveContext: input => ({ ...input }),
    runPendingGates: async (waveCtx, input) => {
      gateCalls.push(input.retryFailed);
      return { gates: [], accepted: [], blocked: [] };
    },
  };
  const gated = await projectCli(['gates', waveId, '--retry-failed', '--json'], { ...base, wave: gatePorts });
  assert.equal(gated.exitCode, 0, gated.output);
  assert.equal(gated.report.result.status, 'passed');
  assert.deepEqual(gateCalls, [true]);

  const [brief] = next.report.result.briefs;
  assert.equal(brief.taskId, 'task-a');
  assert.equal(brief.role, 'architect');
  assert.equal(brief.chatTitle, 'Kodo · [e] Task a');
  assert.deepEqual(JSON.parse(next.output), next.report);

  const human = await projectCli(['next-wave', waveId, '--host', 'orca'], { ...base, wave });
  assert.equal(human.exitCode, 0);
  assert.match(
    human.output,
    /^Project: [0-9a-f-]{36}; revision: \d+\n- Kodo · \[e\] Task a \(architect\)\n {2}worktree: /,
  );
  assert.ok(human.output.includes(brief.completeCommand));
  const other = await projectCli(['next-wave', waveId, '--host', 't3', '--json'], { ...base, wave });
  assert.equal(other.exitCode, 2, 'another host does not receive orca’s attempt');
  assert.deepEqual(other.report.result.briefs, []);

  // An abandon names its attempt: without --attempt it is an argument error that stops nothing.
  const unnamed = await projectCli(
    ['complete-task', waveId, 'task-a', '--head', brief.baseSha, '--abandon', '--json'],
    base,
  );
  assert.deepEqual([unnamed.exitCode, unnamed.report.result.code], [1, 'project_arguments']);
  const abandoned = await projectCli(
    [
      'complete-task',
      waveId,
      'task-a',
      '--head',
      brief.baseSha,
      '--abandon',
      '--attempt',
      brief.attemptId,
      '--command-id',
      crypto.randomUUID(),
    ],
    base,
  );
  assert.equal(abandoned.exitCode, 0, abandoned.output);
  assert.equal(abandoned.report.result.status, 'abandoned');
  const blocked = await projectCli(['complete-task', waveId, 'task-a', '--head', brief.baseSha, '--json'], base);
  assert.equal(blocked.exitCode, 2);
  assert.deepEqual(
    [blocked.report.result.status, blocked.report.result.code],
    ['blocked', 'project_attempt_not_running'],
  );
});
