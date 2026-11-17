import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { workerEnvironment } from '../runtime/security.mjs';
import { reportCli } from '../runtime/report-cli.mjs';
import { projectCli } from '../runtime/project-cli.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const SECRET = 'report-secret-value-0123456789';
// Observe network and native provider entry points, fail closed before any session.
const guard =
  'data:text/javascript,' +
  encodeURIComponent(`
  import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
  import { registerHooks, syncBuiltinESMExports } from 'node:module';
  let network = 0, providers = 0;
  const deny = () => { network++; throw Error('Offline network guard'); };
  globalThis.fetch = deny; http.request = http.get = https.request = https.get = deny;
  net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = deny; syncBuiltinESMExports();
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url.endsWith('/runtime/providers.mjs')) return { ...loaded, source: String(loaded.source).replace(
      /export async function (requestJson|subscriptionStatus|discoverProviders|runSession|analyzeGemini|decideJev|doctorProviders)\\([^]*?\\) \\{/g,
      match => match + " globalThis.__reportProviderAttempt(); ") };
    return loaded;
  } });
  globalThis.__reportProviderAttempt = () => { providers++; throw Error('Offline provider guard'); };
  process.on('exit', () => console.error('offline-attempts:' + network + ':' + providers));
`);

const criterion = id => ({ id, text: 'Independent observable requirement', evidenceKinds: ['acceptance'] });
const task = id => ({
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
});
const metrics = durationMs => ({
  durationMs,
  toolSteps: 1,
  promptBytes: 1200,
  contextOriginalBytes: 4000,
  contextSentBytes: 1000,
  nativeRequestCount: null,
  usage: {
    inputTokens: 50,
    cachedInputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: 60,
    semantics: 'input-includes-cached',
    source: 'codex.usage',
  },
});
const attempt = (stage, status, durationMs) => ({
  stage,
  node: null,
  client: 'codex',
  model: 'gpt-x',
  status,
  metrics: metrics(durationMs),
});

/** Every file under `dir` with its size, modification time and content hash. */
async function inventory(dir) {
  const result = {};
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result[path.relative(dir, file) + '/'] = 'directory';
        await walk(file);
      } else {
        const info = await stat(file);
        result[path.relative(dir, file)] = [
          info.size,
          info.mtimeMs,
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ];
      }
    }
  };
  await walk(dir);
  return result;
}

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-report-cli-')));
  const root = path.join(dir, 'repo'),
    home = path.join(dir, 'state');
  await mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^kodo-report-cli-/);
    await rm(dir, { recursive: true, force: true });
  });
  const store = new Store(home, {});
  try {
    const runId = randomUUID();
    store.createRun({
      id: runId,
      project: root,
      task: 'Report fixture',
      client: 'codex',
      state: 'succeeded',
      executionMode: { selected: 'quick' },
      nodes: { a: { status: 'integrated', attempt: 1 } },
      sessionAttempts: [attempt('plan', 'completed', 400), attempt('developer', 'completed', 900)],
      coordinatorOperations: [{ kind: 'assessment', status: 'completed', durationMs: 50 }],
      checks: {
        schemaVersion: 2,
        complete: true,
        results: [{ kind: 'test', command: { command: 'node', args: ['--test', SECRET] }, exitCode: 0 }],
      },
    });
    store.event(runId, 'check_started', { kind: 'test', command: { command: 'node', args: ['--test'] } });
    store.event(runId, 'succeeded', {});
    const jobs = openJobStore({ store });
    const queue = `run:${runId}:0123456789ab`;
    jobs.enqueue(queue, [{ key: 'a', role: 'developer', writePaths: ['a.txt'] }]);
    jobs.claim(queue, { owner: 'worker-1', limits: { workers: 1, pools: {} } });

    const repo = await openProjectStore({ store, contracts, authorizeTransition: async () => {} });
    const command = (projectId, expectedRevision, action) => ({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId,
      expectedRevision,
      actor: 'report-test',
      reason: 'Owned report fixture',
      action,
    });
    const spec = contracts.normalizeProjectSpec(
      {
        schemaVersion: 1,
        id: 'owned',
        root,
        title: 'Owned report project',
        definitionOfDone: [criterion('project-proof')],
        constraints: ['Only the assigned scope.'],
        businessContext: 'Offline fixture.',
        architectureRefs: [],
        milestones: [
          { id: 'milestone', title: 'Milestone', acceptance: [criterion('milestone-proof')], releaseRequired: false },
        ],
        epics: [{ id: 'epic', milestoneId: 'milestone', title: 'Epic', acceptance: [criterion('epic-proof')] }],
        tasks: [task('task-0'), task('task-1')],
      },
      { knownValues: [] },
    );
    const { projectId } = await repo.apply(command(null, null, { op: 'create', spec }));
    const snapshot = repo.snapshot(projectId);
    const reserved = (
      await repo.apply(
        command(projectId, snapshot.revision, { op: 'reserveAttempt', taskId: 'task-0', retryFailed: false }),
      )
    ).attempt;
    store.createRun({
      id: reserved.runId,
      project: root,
      task: 'Project attempt',
      client: 'codex',
      state: 'blocked',
      directorBinding: {
        schemaVersion: 1,
        projectId,
        taskId: 'task-0',
        taskRevision: reserved.taskRevision,
        attemptId: reserved.id,
        runId: reserved.runId,
        contractHash: reserved.contractHash,
      },
      sessionAttempts: [{ ...attempt('developer', 'failed', 300), errorCode: 'quota' }],
      coordinatorOperations: [],
      blocker: {
        current: {
          code: 'quota',
          scope: 'run',
          message: 'private stop',
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          occurrences: 1,
        },
        history: [],
      },
    });
    store.event(reserved.runId, 'blocked', { code: 'quota', message: 'private stop' });
    return { dir, root, home, runId, projectId, attemptRunId: reserved.runId };
  } finally {
    store.close();
  }
}

const strip = report => ({ ...report, provenance: { ...report.provenance, generatedAt: null } });

test('report reads a saved Run and its jobs strictly read-only', async t => {
  const f = await fixture(t);
  const before = await inventory(f.home);
  const ports = { home: f.home, secrets: { GEMINI_API_KEY: SECRET } };
  const { exitCode, report, output } = await reportCli([f.runId, '--json'], ports);
  assert.equal(exitCode, 0, output);
  assert.deepEqual(JSON.parse(output), report);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'run');
  assert.equal(report.runId, f.runId);
  assert.equal(report.state, 'succeeded');
  assert.equal(report.mode, 'quick');
  assert.equal(report.attempts.sessions, 2);
  assert.equal(report.usage.usage.totalTokens, 120);
  assert.equal(report.timing.stages.planning.durationMs, 400);
  assert.equal(report.timing.stages.implementation.durationMs, 900);
  assert.equal(report.queue.jobs, 1);
  assert.equal(report.queue.source, 'job-events');
  assert.equal(typeof report.queue.waitMs, 'number');
  assert.ok(Number.isSafeInteger(report.timing.wallMs) && report.timing.wallMs >= 0);
  assert.ok(!output.includes(SECRET), 'saved values matching credentials are redacted');
  assert.match(report.checks.runs[0].command, /\[REDACTED\]/);

  const human = await reportCli([f.runId], ports);
  assert.equal(human.exitCode, 0);
  assert.match(human.output, new RegExp(f.runId));
  assert.match(human.output, /succeeded/);
  assert.match(human.output, /prompt bytes are not tokens/i);
  assert.ok(!human.output.includes(SECRET));

  assert.deepEqual(await inventory(f.home), before, 'a report creates and changes nothing in the state home');
});

test('project report and the project alias read the snapshot and attempt Runs', async t => {
  const f = await fixture(t);
  const before = await inventory(f.home);
  const ports = { home: f.home, secrets: {} };
  const { exitCode, report, output } = await reportCli(['--project', f.projectId, '--json'], ports);
  assert.equal(exitCode, 0, output);
  assert.equal(report.kind, 'project');
  assert.equal(report.projectId, f.projectId);
  assert.deepEqual(
    report.tasks.map(row => [row.id, row.attempts, row.lastRunState]),
    [
      ['task-0', 1, 'blocked'],
      ['task-1', 0, null],
    ],
  );
  assert.equal(report.totals.attempts, 1);
  assert.equal(report.totals.usage.sessions, 1);
  assert.deepEqual(report.completeness.runs, { known: 1, total: 1, complete: true });
  assert.deepEqual(report.blockers, [
    { taskId: 'task-0', runId: f.attemptRunId, code: 'quota', scope: 'run', occurrences: 1 },
  ]);
  assert.ok(!output.includes('private stop'));

  const flagFirst = await reportCli(['--json', '--project', f.projectId], ports);
  assert.deepEqual(strip(flagFirst.report), strip(report));
  const alias = await projectCli(['report', f.projectId, '--json'], ports);
  assert.equal(alias.exitCode, 0, alias.output);
  assert.deepEqual(strip(alias.report), strip(report));
  const human = await projectCli(['report', f.projectId], ports);
  assert.equal(human.exitCode, 0);
  assert.match(human.output, new RegExp(f.projectId));
  assert.match(human.output, /task-0/);

  assert.deepEqual(await inventory(f.home), before);
});

test('invalid arguments fail before credentials or state are opened', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodo-report-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'never-created');
  const ports = {
    home,
    loadSecrets: async () => assert.fail('credentials must not load before strict parsing'),
  };
  const id = randomUUID();
  for (const argv of [
    [],
    ['--json'],
    ['not-a-run-id'],
    [id, id],
    [id, '--json', '--json'],
    [id, '--project', id],
    ['--project'],
    ['--project', 'not-a-project'],
    ['--project', id, '--project', id],
    ['--bogus', id],
    [`${id}\u0000`],
    [id.toUpperCase().replace(/-/g, '')],
    'not-an-array',
    [42],
  ]) {
    const { exitCode, report, output } = await reportCli(/** @type {any} */ (argv), ports);
    assert.equal(exitCode, 1, JSON.stringify(argv));
    assert.deepEqual(report, { schemaVersion: 1, kind: 'error', status: 'invalid', code: 'report_arguments' });
    assert.ok(!output.includes('not-a-run-id') && !output.includes('not-a-project'), 'arguments are never echoed');
  }
  const alias = await projectCli(['report', 'not-a-project', '--json'], ports);
  assert.equal(alias.exitCode, 1);
  assert.equal(alias.report.code, 'report_arguments');
  assert.equal(existsSync(home), false, 'no state home is created');
});

test('missing Runs, Projects and state report constant codes without paths', async t => {
  const f = await fixture(t);
  const before = await inventory(f.home);
  const ports = { home: f.home, secrets: {} };
  for (const argv of [
    [randomUUID(), '--json'],
    ['--project', randomUUID(), '--json'],
  ]) {
    const { exitCode, report } = await reportCli(argv, ports);
    assert.equal(exitCode, 1);
    assert.deepEqual(report, { schemaVersion: 1, kind: 'error', status: 'invalid', code: 'report_not_found' });
  }
  const absent = path.join(f.dir, 'absent-home');
  const missing = await reportCli([f.runId, '--json'], { home: absent, secrets: {} });
  assert.equal(missing.report.code, 'report_not_found');
  assert.equal(existsSync(absent), false);

  const broken = path.join(f.dir, 'broken-home');
  await mkdir(broken);
  await writeFile(path.join(broken, 'state.sqlite'), 'not a database');
  const corrupt = await reportCli([f.runId, '--json'], { home: broken, secrets: {} });
  assert.equal(corrupt.exitCode, 2);
  assert.deepEqual(corrupt.report, { schemaVersion: 1, kind: 'error', status: 'blocked', code: 'report_unavailable' });
  assert.ok(!corrupt.output.includes(broken));
  assert.deepEqual(await readdir(broken), ['state.sqlite']);
  assert.deepEqual(await inventory(f.home), before);
});

test('kodo report runs as a process without network or provider attempts', async t => {
  const f = await fixture(t);
  const isolated = path.join(f.dir, 'empty-home');
  await mkdir(isolated);
  const before = await inventory(f.home);
  const env = {
    ...workerEnvironment(),
    HOME: isolated,
    USERPROFILE: isolated,
    LOCALAPPDATA: isolated,
    XDG_CONFIG_HOME: isolated,
    KODO_HOME: f.home,
    KODO_CREDENTIAL_HOME: path.join(f.dir, 'credentials'),
  };
  const invoke = args => {
    const result = spawnSync(process.execPath, ['--import', guard, cli, ...args], {
      cwd: f.root,
      env,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /offline-attempts:0:0/);
    return result;
  };
  const run = invoke(['report', f.runId, '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).kind, 'run');
  const project = invoke(['project', 'report', f.projectId, '--json']);
  assert.equal(project.status, 0, project.stderr);
  assert.equal(JSON.parse(project.stdout).projectId, f.projectId);
  const human = invoke(['report', '--project', f.projectId]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /task-0/);
  const invalid = invoke(['report', '--project', 'nope', '--json']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).code, 'report_arguments');
  assert.deepEqual(await inventory(f.home), before);
});
