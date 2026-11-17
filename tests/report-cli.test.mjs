import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { workerEnvironment } from '../runtime/security.mjs';
import { reportCli } from '../runtime/report-cli.mjs';
import { readRedactionSecrets, readReportState, REMOVE_ATTEMPTS, STATE_ATTEMPTS } from '../runtime/report-state.mjs';
import { projectCli } from '../runtime/project-cli.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const SECRET = 'report-secret-value-0123456789';
const PASSWORD = 'check-password-value-42';
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

/** Every file under `dir` with its size, modification time and content hash (synchronous, so a hook can take it). */
function inventory(dir) {
  const result = {};
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result[path.relative(dir, file) + '/'] = 'directory';
        walk(file);
      } else {
        const info = statSync(file);
        result[path.relative(dir, file)] = [
          info.size,
          info.mtimeMs,
          createHash('sha256').update(readFileSync(file)).digest('hex'),
        ];
      }
    }
  };
  walk(dir);
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
        results: [
          {
            kind: 'test',
            command: {
              command: path.join(root, 'tools', 'node'),
              args: ['--test', path.join(root, 'test', 'private.test.mjs'), '--password', PASSWORD, SECRET],
            },
            exitCode: 0,
          },
        ],
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
    const attemptQueue = `run:${reserved.runId}:0123456789ab`;
    jobs.enqueue(attemptQueue, [{ key: 'a', role: 'developer', writePaths: ['a.txt'] }]);
    jobs.claim(attemptQueue, { owner: 'worker-1', limits: { workers: 1, pools: {} } });
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
  // A check is its kind and executable name: no path and no argument value is printed.
  assert.deepEqual(report.checks.runs, [{ kind: 'test', executable: 'node', durationMs: null, exitCode: 0 }]);
  // Without pending WAL frames the live main file is read immutable, in one attempt.
  assert.deepEqual(report.provenance.snapshot, { method: 'immutable', attempts: 1 });

  const human = await reportCli([f.runId], ports);
  assert.equal(human.exitCode, 0);
  assert.match(human.output, new RegExp(f.runId));
  assert.match(human.output, /succeeded/);
  assert.match(human.output, /prompt bytes are not tokens/i);
  for (const text of [output, human.output])
    for (const value of [SECRET, PASSWORD, f.root, 'private.test.mjs', '--password'])
      assert.ok(!text.includes(value), value);

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
  // The attempt's durable job and its queue wait are read from the same snapshot.
  assert.deepEqual(
    report.attempts.map(row => [
      row.taskId,
      row.number,
      row.runId,
      row.state,
      row.waits.queue.known,
      row.waits.queue.total,
    ]),
    [['task-0', 1, f.attemptRunId, 'blocked', 1, 1]],
  );
  assert.deepEqual(
    report.attempts[0].failures.map(item => `${item.code}@${item.scope}`),
    ['quota@run', 'quota@session:developer'],
  );
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
  assert.match(human.output, /Waits: queue .*CI/);
  assert.match(human.output, /task-0 #1 blocked: .*failures quota@run, quota@session:developer/);

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

/** Run the real CLI under the offline guard with a private user profile. */
function invokeCli(f, args) {
  const isolated = path.join(f.dir, 'empty-home');
  mkdirSync(isolated, { recursive: true });
  const env = {
    ...workerEnvironment(),
    HOME: isolated,
    USERPROFILE: isolated,
    LOCALAPPDATA: isolated,
    XDG_CONFIG_HOME: isolated,
    KODO_HOME: f.home,
    KODO_CREDENTIAL_HOME: path.join(f.dir, 'credentials'),
  };
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
}

test('kodo report runs as a process without network or provider attempts', async t => {
  const f = await fixture(t);
  mkdirSync(path.join(f.dir, 'empty-home'));
  const before = inventory(f.dir);
  const run = invokeCli(f, ['report', f.runId, '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).kind, 'run');
  const project = invokeCli(f, ['project', 'report', f.projectId, '--json']);
  assert.equal(project.status, 0, project.stderr);
  assert.equal(JSON.parse(project.stdout).projectId, f.projectId);
  const human = invokeCli(f, ['report', '--project', f.projectId]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /task-0/);
  const invalid = invokeCli(f, ['report', '--project', 'nope', '--json']);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).code, 'report_arguments');
  // Neither the state home nor the (absent) credential directory is created or changed.
  assert.deepEqual(inventory(f.dir), before);
});

test('kodo report reads a legacy key file for redaction and never migrates it', async t => {
  const f = await fixture(t);
  const runId = randomUUID();
  const store = new Store(f.home, {});
  try {
    // The saved model name equals the key: the legacy file must still redact it.
    store.createRun({
      id: runId,
      project: f.root,
      task: 'Legacy key fixture',
      client: 'codex',
      state: 'succeeded',
      sessionAttempts: [{ ...attempt('developer', 'completed', 100), model: SECRET }],
      coordinatorOperations: [],
    });
    store.event(runId, 'succeeded', {});
  } finally {
    store.close();
  }
  await writeFile(path.join(f.home, 'secrets.json'), JSON.stringify({ GEMINI_API_KEY: SECRET }));
  mkdirSync(path.join(f.dir, 'empty-home'));
  const before = inventory(f.dir);
  const result = invokeCli(f, ['report', runId, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(SECRET));
  assert.deepEqual(JSON.parse(result.stdout).models, [{ client: 'codex', model: '[REDACTED]', sessions: 1 }]);
  const unknown = invokeCli(f, ['report', randomUUID(), '--json']);
  assert.equal(JSON.parse(unknown.stdout).code, 'report_not_found');
  // The legacy file stays byte for byte; no credential store or directory appears.
  assert.deepEqual(inventory(f.dir), before);
  assert.equal(existsSync(path.join(f.dir, 'credentials')), false);
});

test('a writer closing between the state probe and the open changes no state file', async t => {
  const f = await fixture(t);
  const temporaryRoot = path.join(f.dir, 'snapshots');
  mkdirSync(temporaryRoot);
  const writer = new Store(f.home, {});
  let closed = false,
    expected,
    open,
    live,
    raced;
  try {
    // Pending WAL frames with the shared-memory file: the report must not open the live files.
    writer.event(f.runId, 'check_started', { kind: 'test', command: { command: 'node', args: [] } });
    assert.ok(statSync(path.join(f.home, 'state.sqlite-wal')).size > 0);
    live = inventory(f.home);
    open = await reportCli([f.runId, '--json'], { home: f.home, secrets: {}, temporaryRoot });
    assert.deepEqual(inventory(f.home), live);
    raced = await reportCli([f.runId, '--json'], {
      home: f.home,
      secrets: {},
      temporaryRoot,
      stateProbed: () => {
        if (closed) return;
        writer.close();
        closed = true;
        expected = inventory(f.home);
      },
    });
  } finally {
    if (!closed) writer.close();
  }
  assert.equal(open.exitCode, 0, open.output);
  assert.equal(open.report.checks.executions, 2, 'committed WAL frames are read from a private copy');
  assert.deepEqual(open.report.provenance.snapshot, { method: 'wal-copy', attempts: 1 });
  assert.equal(raced.exitCode, 0, raced.output);
  assert.equal(raced.report.checks.executions, 2);
  assert.deepEqual(inventory(f.home), expected, 'no -wal or -shm appears after the writer closed');
  assert.deepEqual(readdirSync(temporaryRoot), [], 'every private copy is removed');
});

test('the project report never runs the project migration', async t => {
  const f = await fixture(t);
  const database = path.join(f.home, 'state.sqlite');
  const edit = sql => {
    const db = new DatabaseSync(database);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  // Project tables exist but the version table is empty: only a writer may migrate.
  edit('DELETE FROM kodo_project_migrations');
  for (const step of [
    null,
    `INSERT INTO kodo_project_migrations VALUES(1,'${'f'.repeat(64)}','2026-01-01T00:00:00.000Z')`,
  ]) {
    if (step) edit(step);
    const before = inventory(f.home);
    const { exitCode, report } = await reportCli(['--project', f.projectId, '--json'], { home: f.home, secrets: {} });
    assert.equal(exitCode, 2);
    assert.deepEqual(report, { schemaVersion: 1, kind: 'error', status: 'blocked', code: 'report_unavailable' });
    // No new `project-backups/migration-*` copy, no DDL: the state home is unchanged.
    assert.deepEqual(inventory(f.home), before);
  }
});

test('a state that changes during every copy is refused after bounded attempts', async t => {
  const f = await fixture(t);
  const temporaryRoot = path.join(f.dir, 'snapshots');
  mkdirSync(temporaryRoot);
  const writer = new Store(f.home, {});
  let probes = 0,
    result;
  try {
    writer.event(f.runId, 'note', {});
    result = await reportCli([f.runId, '--json'], {
      home: f.home,
      secrets: {},
      temporaryRoot,
      // A commit after each probe: every copy differs from the files that were inspected.
      stateProbed: () => {
        probes++;
        writer.event(f.runId, 'note', {});
      },
    });
  } finally {
    writer.close();
  }
  const { exitCode, report } = result;
  assert.equal(exitCode, 2);
  assert.deepEqual(report, { schemaVersion: 1, kind: 'error', status: 'blocked', code: 'report_unavailable' });
  assert.equal(probes, STATE_ATTEMPTS);
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test('a read that raced a checkpoint of the main file is read again', async t => {
  const f = await fixture(t);
  const database = path.join(f.home, 'state.sqlite');
  const seen = [],
    snapshots = [];
  const counts = await readReportState(f.home, state => {
    seen.push(state.db.prepare('SELECT COUNT(*) AS n FROM events').get().n);
    snapshots.push(state.snapshot);
    if (seen.length === 1) {
      // A writer commits and, closing, checkpoints into the main file while it is read.
      const writer = new DatabaseSync(database);
      writer
        .prepare('INSERT INTO events(run_id,type,data,time) VALUES(?,?,?,?)')
        .run(f.runId, 'note', '{}', Date.now());
      writer.close();
    }
    return seen.at(-1);
  });
  assert.equal(seen.length, 2, 'the first read is discarded');
  assert.equal(counts, seen[0] + 1, 'the second read sees the checkpointed row');
  assert.deepEqual(snapshots.at(-1), { method: 'immutable', attempts: 2 });
});

/** Run `body` while a writer keeps its last commit in the WAL (with its shared-memory index). */
async function withWriter(f, body) {
  const writer = new Store(f.home, {});
  try {
    writer.event(f.runId, 'check_started', { kind: 'test', command: { command: 'node', args: [] } });
    assert.ok(statSync(path.join(f.home, 'state.sqlite-wal')).size > 0);
    return await body();
  } finally {
    writer.close();
  }
}

test('an unfinished WAL tail is ignored: the report reads the last whole commit from a private copy', async t => {
  const f = await fixture(t);
  const temporaryRoot = path.join(f.dir, 'snapshots');
  mkdirSync(temporaryRoot);
  await withWriter(f, async () => {
    // A frame that was never fully written: SQLite ignores it for every reader, and so does the copy.
    appendFileSync(path.join(f.home, 'state.sqlite-wal'), Buffer.alloc(1000, 0x5a));
    const live = inventory(f.home);
    const { exitCode, report, output } = await reportCli([f.runId, '--json'], {
      home: f.home,
      secrets: {},
      temporaryRoot,
    });
    assert.equal(exitCode, 0, output);
    assert.equal(report.checks.executions, 2, 'the last whole commit is read');
    assert.deepEqual(report.provenance.snapshot, { method: 'wal-copy', attempts: 1 });
    assert.deepEqual(inventory(f.home), live, 'the live files, with their tail, are not changed');
  });
  assert.deepEqual(readdirSync(temporaryRoot), []);
});

test('a temporary root inside or around the state or credential home is refused before any copy', async t => {
  const f = await fixture(t);
  const keys = path.join(f.dir, 'credentials'),
    keysTemp = path.join(keys, 'tmp'),
    outer = path.join(f.dir, 'outer');
  for (const item of [keysTemp, outer]) mkdirSync(item, { recursive: true });
  await withWriter(f, async () => {
    const around = inventory(f.dir);
    for (const [temporaryRoot, credentialHome] of [
      [f.home, keys], // TEMP=KODO_HOME: a copy would land in the state home.
      [keysTemp, keys], // Inside the credential home.
      [outer, path.join(outer, 'keys')], // Around a (not yet created) credential home.
      [f.dir, keys], // Around the state home.
    ]) {
      const { exitCode, report } = await reportCli([f.runId, '--json'], {
        home: f.home,
        secrets: {},
        temporaryRoot,
        credentialHome,
      });
      assert.equal(exitCode, 2, temporaryRoot);
      assert.deepEqual(report, { schemaVersion: 1, kind: 'error', status: 'blocked', code: 'report_unavailable' });
      assert.deepEqual(inventory(f.dir), around, 'no snapshot directory is created anywhere');
    }
    const allowed = path.join(f.dir, 'snapshots');
    mkdirSync(allowed);
    const ok = await reportCli([f.runId, '--json'], {
      home: f.home,
      secrets: {},
      temporaryRoot: allowed,
      credentialHome: keys,
    });
    assert.equal(ok.exitCode, 0, ok.output);
    assert.equal(ok.report.provenance.snapshot.method, 'wal-copy');
    assert.deepEqual(readdirSync(allowed), []);
  });
});

test('a private copy held by a transient lock is removed after bounded retries', async t => {
  const f = await fixture(t);
  const temporaryRoot = path.join(f.dir, 'snapshots');
  mkdirSync(temporaryRoot);
  const locked = code => Object.assign(new Error('locked'), { code });
  let calls = 0;
  const [flaky, stuck] = await withWriter(f, async () => [
    await reportCli([f.runId, '--json'], {
      home: f.home,
      secrets: {},
      temporaryRoot,
      // Windows keeps a handle open for a moment after SQLite closed the copy.
      removeDirectory: (directory, options) => {
        calls++;
        if (calls <= 2) throw locked(calls === 1 ? 'EPERM' : 'EBUSY');
        rmSync(directory, options);
      },
    }),
    await reportCli([f.runId, '--json'], {
      home: f.home,
      secrets: {},
      temporaryRoot,
      removeDirectory: () => {
        calls++;
        throw locked('EPERM');
      },
    }),
  ]);
  assert.equal(flaky.exitCode, 0, flaky.output);
  assert.equal(flaky.report.provenance.snapshot.method, 'wal-copy');
  // A copy that cannot be removed is never left behind silently: the report fails closed.
  assert.equal(stuck.exitCode, 2);
  assert.equal(stuck.report.code, 'report_unavailable');
  assert.equal(calls, 3 + REMOVE_ATTEMPTS);
  assert.equal(readdirSync(temporaryRoot).length, 1, 'only the copy whose removal kept failing remains');
});

test('redaction keys are read from the store and a legacy file without writing either', async t => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-report-keys-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'state'),
    directory = path.join(dir, 'credentials'),
    broken = path.join(dir, 'broken');
  for (const item of [home, directory, broken]) mkdirSync(item);
  writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ GEMINI_API_KEY: 'legacy-key-value-1' }));
  writeFileSync(
    path.join(directory, 'credentials.json'),
    JSON.stringify({ version: 1, protection: 'file-permissions', data: { GEMINI_API_KEY: 'stored-key-value-2' } }),
  );
  const cipher = Buffer.from('opaque-ciphertext').toString('base64');
  writeFileSync(
    path.join(directory, 'credentials.dpapi.json'),
    JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', data: cipher }),
  );
  writeFileSync(path.join(broken, 'credentials.json'), JSON.stringify({ version: 2, data: {} }));
  const before = inventory(dir);

  const posix = await readRedactionSecrets({
    home,
    directory,
    platform: 'linux',
    environment: { KODO_SCRAPEDO_TOKEN: 'environment-token-3' },
  });
  assert.deepEqual(Object.values(posix).sort(), ['environment-token-3', 'legacy-key-value-1', 'stored-key-value-2']);
  const windows = await readRedactionSecrets({
    home,
    directory,
    platform: 'win32',
    environment: {},
    decrypt: async ciphertext => {
      assert.equal(ciphertext.toString(), 'opaque-ciphertext');
      return Buffer.from(JSON.stringify({ GEMINI_API_KEY: 'dpapi-key-value-4' }));
    },
  });
  assert.deepEqual(Object.values(windows).sort(), ['dpapi-key-value-4', 'legacy-key-value-1']);
  // A store that exists but cannot be read fails closed: no report without the keys it must redact.
  const unavailable = { code: 'report_unavailable' };
  await assert.rejects(
    readRedactionSecrets({ home, directory, platform: 'win32', environment: {}, decrypt: async () => assert.fail() }),
    unavailable,
  );
  await assert.rejects(
    readRedactionSecrets({ home, directory: broken, platform: 'linux', environment: {} }),
    unavailable,
  );
  const nowhere = path.join(dir, 'absent');
  assert.deepEqual(
    await readRedactionSecrets({ home: nowhere, directory: path.join(nowhere, 'keys'), environment: {} }),
    {},
  );
  assert.equal(existsSync(nowhere), false);
  assert.deepEqual(inventory(dir), before, 'no file is created, migrated, removed or changed');
});
