import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectCli } from '../runtime/project-cli.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const criterion = id => ({ id, text: 'Independent observable requirement', evidenceKinds: ['acceptance'] });
const task = (id, overrides = {}) => ({
  id,
  epicId: 'epic',
  title: 'Assigned task',
  description: 'Implement the assigned file.',
  owner: 'developer',
  dependsOn: [],
  writePaths: [id + '.txt'],
  acceptance: [criterion('task-proof')],
  interfaceRefs: [],
  priority: 50,
  userValue: 1,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...overrides,
});
const spec = (root, extra = {}) => ({
  schemaVersion: 1,
  id: 'owned',
  root,
  title: 'Owned wave CLI project',
  definitionOfDone: [criterion('project-proof')],
  constraints: ['Only the assigned scope.'],
  businessContext: 'Offline fixture.',
  architectureRefs: [],
  milestones: [
    { id: 'milestone', title: 'Milestone', acceptance: [criterion('milestone-proof')], releaseRequired: false },
  ],
  epics: [{ id: 'epic', milestoneId: 'milestone', title: 'Epic', acceptance: [criterion('epic-proof')] }],
  tasks: [task('task-a', { riskApprovalRequired: true })],
  ...extra,
});

test('Project drain strict grammar rejects invalid arguments before credentials, state or providers', async () => {
  const id = randomUUID();
  const cases = [
    ['drain'],
    ['drain', 'bad'],
    ['drain', id, 'extra'],
    ['drain', id, '--max-waves', '0'],
    ['drain', id, '--max-waves', '101'],
    ['drain', id, '--max-waves', '1.5'],
    ['drain', id, '--max-waves', '-1'],
    ['drain', id, '--concurrency', '0'],
    ['drain', id, '--concurrency', '65'],
    ['drain', id, '--concurrency'],
    ['drain', id, '--max-waves', '--json'],
    ['drain', id, '--retry-failed', '--retry-failed'],
    ['drain', id, '--concurrency', '2', '--concurrency', '3'],
    ['drain', id, '--command-id', 'bad'],
    ['drain', id, '--limit', '2'],
    ['drain', id, '--mode', 'deep'],
    ['drain', id, '--model', 'x'],
    ['drain', id, '--client', 'codex'],
    ['drain', id, '--dry-run'],
    ['drain', id, '--json=true'],
    ['drain', id, '\u0001'],
    ['drain', '11111111-1111-4111-8111-11111111111g'],
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
    createEngine: () => {
      calls++;
      throw Error('Must parse first');
    },
  };
  for (const args of cases) {
    const result = await projectCli([...args, ...(args.includes('--json') ? [] : ['--json'])], ports);
    assert.equal(result.exitCode, 1, args.join(' '));
    assert.equal(result.report.result.status, 'invalid');
    assert.equal(result.report.result.code, 'project_arguments');
    assert.deepEqual(JSON.parse(result.output), result.report);
  }
  assert.equal(calls, 0);
});

test('Project drain reports a blocked wave project and refuses a legacy one with exit 2', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-cli-')));
  t.after(async () => {
    assert.match(path.basename(directory), /^kodo-wave-cli-/);
    await rm(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, 'state');
  const ports = { secrets: {}, home };
  const create = async (name, extra) => {
    const root = path.join(directory, name);
    await mkdir(root);
    const file = path.join(directory, `${name}.json`);
    await writeFile(file, JSON.stringify(spec(root, extra)));
    const created = await projectCli(['create', '--file', file, '--json'], ports);
    assert.equal(created.exitCode, 0, created.output);
    return created.report.projectId;
  };
  const waveId = await create('wave', { execution: { cadence: 'wave', integration: 'branch' } });
  const blocked = await projectCli(['drain', waveId, '--max-waves', '2', '--concurrency', '2', '--json'], ports);
  assert.equal(blocked.exitCode, 2, blocked.output);
  assert.equal(blocked.report.projectId, waveId);
  assert.equal(blocked.report.result.status, 'blocked');
  assert.equal(blocked.report.result.code, 'risk_approval_required');
  assert.equal(blocked.report.result.waves, 0);
  assert.equal(blocked.report.revision, 1);
  const drainEight = () => projectCli(['drain', waveId, '--concurrency', '8', '--json'], ports);
  assert.equal((await drainEight()).exitCode, 1);
  const file = path.join(directory, 'pools.json');
  await writeFile(
    file,
    JSON.stringify({
      subscriptions: [{ id: 'a', model: 'gpt', provider: 'codex', tier: 'fast', slots: 8 }],
      machines: [{ id: 'pc', kind: 'local', maxWorkers: 8, maxHeavyBuilds: 1 }],
    }),
  );
  assert.equal((await projectCli(['profile', 'set', waveId, '--file', file], ports)).exitCode, 0);
  assert.equal((await drainEight()).report.result.code, 'risk_approval_required');
  const legacyId = await create('legacy');
  const legacy = await projectCli(['drain', legacyId, '--json'], ports);
  assert.equal(legacy.exitCode, 2);
  // Audit finding 8e: the constant refusal is reported, not hidden as project_blocked.
  assert.deepEqual(legacy.report.result, { status: 'blocked', code: 'project_wave_not_enabled' });
});

test('CLI help lists project drain', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /kodo project drain PROJECT_ID \[--max-waves 1\.\.100\] \[--concurrency N\] \[--retry-failed\] \[--command-id UUID\] \[--json\]/,
  );
});
