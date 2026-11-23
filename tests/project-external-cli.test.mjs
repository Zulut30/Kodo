import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectCli } from '../runtime/project-cli.mjs';
import { projectExternalCli } from '../runtime/project-cli-external.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
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
  assert.equal(brief.chatTitle, 'Kodo · [e] Task a · попытка 1');
  assert.deepEqual(JSON.parse(next.output), next.report);
  // Without a CLI context (a library caller) the commands keep the `kodo` prefix.
  assert.equal(next.report.result.cli, 'kodo');
  assert.ok(brief.completeCommand.startsWith('kodo project complete-task '));

  const human = await projectCli(['next-wave', waveId, '--host', 'orca'], { ...base, wave });
  assert.equal(human.exitCode, 0);
  assert.match(
    human.output,
    /^Project: [0-9a-f-]{36}; revision: \d+\n- Kodo · \[e\] Task a · попытка 1 \(architect\)\n {2}worktree: /,
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

test(
  'The real CLI issues next-wave briefs whose commands call its own absolute entry',
  { timeout: 180000 },
  async t => {
    const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-external-cli-')));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const isolated = path.join(temp, 'empty-home');
    await mkdir(isolated);
    await writeFile(path.join(isolated, 'gitconfig'), '');
    const env = {
      ...workerEnvironment(),
      HOME: isolated,
      USERPROFILE: isolated,
      LOCALAPPDATA: isolated,
      XDG_CONFIG_HOME: isolated,
      KODO_HOME: path.join(temp, 'state'),
      KODO_CREDENTIAL_HOME: path.join(temp, 'credentials'),
      // Spaces and Cyrillic: an ordinary quoted argument in every shell.
      KODO_WORKTREE_HOME: path.join(temp, 'рабочие копии'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
    };
    // `node` without a path, as the main chat's shell finds it.
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = [path.dirname(process.execPath), env[pathKey]].filter(Boolean).join(path.delimiter);
    const kodo = (...args) => {
      const result = spawnSync(process.execPath, [cli, 'project', ...args, '--json'], {
        env,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      return { exitCode: result.status, report: JSON.parse(result.stdout) };
    };
    const created = kodo('create', '--file', await project(t, temp, 'wave', true));
    assert.equal(created.exitCode, 0, JSON.stringify(created.report));
    const projectId = created.report.projectId;
    const next = kodo('next-wave', projectId, '--host', 't3');
    assert.equal(next.exitCode, 0, JSON.stringify(next.report));
    const prefix = `node "${cli}"`;
    assert.equal(next.report.result.cli, prefix);
    const [brief] = next.report.result.briefs;
    assert.equal(brief.selfCheck, `${prefix} ci feedback --base ${brief.baseSha} --project "${brief.worktree}" --json`);
    const shaCommand = /\(git -C "[^"]+" rev-parse HEAD\)/.exec(brief.prompt)?.[0].slice(1, -1);
    assert.equal(shaCommand, `git -C "${brief.worktree}" rev-parse HEAD`);
    assert.equal(
      spawnSync(shaCommand, { shell: true, cwd: temp, env, encoding: 'utf8', windowsHide: true }).stdout.trim(),
      brief.baseSha,
    );
    assert.equal(
      brief.completeCommand,
      `${prefix} project complete-task ${projectId} task-a --head <SHA> --attempt ${brief.attemptId} --defer-gate`,
    );
    assert.equal(
      brief.abandonCommand,
      `${prefix} project complete-task ${projectId} task-a --head <SHA> --abandon --attempt ${brief.attemptId}`,
    );
    assert.ok(brief.worktree.startsWith(path.join(temp, 'рабочие копии')));
    // The brief's commands run as written in the platform shell (cmd.exe on Windows, sh elsewhere).
    const shell = command =>
      spawnSync(command, { shell: true, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    const feedback = shell(brief.selfCheck);
    assert.equal(JSON.parse(feedback.stdout).project, brief.worktree, feedback.stdout + feedback.stderr);
    const abandon = spawnSync(`${brief.abandonCommand.replace('<SHA>', brief.baseSha)} --json`, {
      shell: true,
      env,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    assert.equal(abandon.status, 0, abandon.stdout + abandon.stderr);
    assert.equal(JSON.parse(abandon.stdout).result.status, 'abandoned');
  },
);

test('next-wave refuses an unusable CLI prefix port before the Store opens', async () => {
  const closed = { secrets: {}, openStore: () => assert.fail('the Store stays closed') };
  for (const [cli, code] of [
    [null, 'project_cli_invalid'],
    ['npx kodo', 'project_cli_invalid'],
    ['node "cli/index.mjs"', 'project_path_unsafe'],
    [`node "${path.join(os.tmpdir(), 'kodo $(calc)', 'index.mjs')}"`, 'project_path_unsafe'],
  ]) {
    const result = await projectCli(['next-wave', id, '--host', 't3', '--json'], { ...closed, cli });
    assert.equal(result.exitCode, 1, String(cli));
    assert.equal(result.report.result.code, code, String(cli));
    if (code === 'project_path_unsafe') assert.match(result.report.result.message, /переименуйте или переместите/);
  }
});

test('Pull CLI reports known operation errors without leaking exception details', async t => {
  for (const code of [
    'project_integration_branch_busy',
    'project_frontier_integration_missing',
    'project_wave_policy_invalid',
    'project_wave_policy_unsafe',
    'project_entity_not_found',
  ])
    await t.test(code, async () => {
      const result = await projectExternalCli(['gates', id, '--json'], {
        secrets: {},
        openStore: () => {
          throw Object.assign(new Error('private detail'), { code });
        },
      });
      assert.equal(result.report.result.code, code);
      assert.equal(result.exitCode, code === 'project_entity_not_found' ? 1 : 2);
      assert.ok(!result.output.includes('private detail'));
    });
});
