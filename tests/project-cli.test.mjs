import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { workerEnvironment, createCredentialStore } from '../runtime/security.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const load = () => import('../runtime/project-cli.mjs');
const criterion = id => ({ id, text: 'Independent observable requirement', evidenceKinds: ['acceptance'] });
const task = id => ({ id, epicId: 'epic', title: 'Assigned task', description: 'Implement the assigned file.',
  owner: 'developer', dependsOn: [], writePaths: [id + '.txt'], acceptance: [criterion('task-proof')], interfaceRefs: [],
  priority: 50, userValue: 1, risk: 1, estimatedEffort: 1, riskApprovalRequired: false });
const spec = (root, count = 1) => ({ schemaVersion: 1, id: 'owned', root, title: 'Owned CLI project',
  definitionOfDone: [criterion('project-proof')], constraints: ['Only the assigned scope.'], businessContext: 'Offline fixture.',
  architectureRefs: [], milestones: [{ id: 'milestone', title: 'Milestone', acceptance: [criterion('milestone-proof')], releaseRequired: false }],
  epics: [{ id: 'epic', milestoneId: 'milestone', title: 'Epic', acceptance: [criterion('epic-proof')] }],
  tasks: Array.from({ length: count }, (_, i) => task('task-' + i)) });
// Observe network and native provider entry points, fail closed before any session.
const guard = 'data:text/javascript,' + encodeURIComponent(`
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
      match => match + " globalThis.__projectProviderAttempt(); ") };
    return loaded;
  } });
  globalThis.__projectProviderAttempt = () => { providers++; throw Error('Offline provider guard'); };
  process.on('exit', () => console.error('offline-attempts:' + network + ':' + providers));
`);
async function fixture(t, count = 1) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-project-cli-')));
  const root = path.join(dir, 'repo'), home = path.join(dir, 'state'), credentials = path.join(dir, 'credentials'), isolated = path.join(dir, 'empty-home');
  await mkdir(root); await mkdir(isolated);
  const env = { ...workerEnvironment(), HOME: isolated, USERPROFILE: isolated, LOCALAPPDATA: isolated, XDG_CONFIG_HOME: isolated,
    KODO_HOME: home, KODO_CREDENTIAL_HOME: credentials, KODO_WORKTREE_HOME: path.join(dir, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
  await writeFile(path.join(root, 'kodo.config.json'), JSON.stringify({ schemaVersion: 1, client: 'codex', executionMode: 'quick',
    maxTasks: 1, concurrency: 1, researchBudget: 0, repairRounds: 1, commands: { test: [], build: [], deploy: [], smoke: [] },
    delivery: { enabled: false }, security: { enabled: false }, uiVerification: { enabled: false }, architecture: { enabled: false } }));
  git('init', '-b', 'main'); git('config', 'user.name', 'Owned CLI'); git('config', 'user.email', 'cli@example.invalid');
  git('config', 'commit.gpgSign', 'false'); git('add', '.'); git('commit', '-m', 'Owned fixture');
  const input = spec(root, count), file = path.join(dir, 'input.json');
  await writeFile(file, JSON.stringify(input));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.match(path.basename(dir), /^kodo-project-cli-/); await rm(dir, { recursive: true, force: true }); });
  const invoke = (args, json = true, extraEnv = {}) => {
    const result = spawnSync(process.execPath, ['--import', guard, cli, ...args, ...(json ? ['--json'] : [])],
      { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined); assert.match(result.stderr, /offline-attempts:0:0/);
    return { exitCode: result.status, report: json ? JSON.parse(result.stdout) : null, output: result.stdout, stderr: result.stderr };
  };
  return { dir, root, home, credentials, env, input, file, invoke };
}
function isolateProcess(t, f) {
  const keys = new Set([...Object.keys(f.env), ...Object.keys(process.env)]);
  const before = new Map([...keys].map(key => [key, process.env[key]]));
  for (const key of keys) { if (f.env[key] === undefined) delete process.env[key]; else process.env[key] = f.env[key]; }
  t.after(() => { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('Project strict grammar rejects invalid arguments before credentials, state or provider ports', async () => {
  const { projectCli } = await load();
  const id = randomUUID();
  const cases = [[], ['unknown'], ['create'], ['create', '--file', 'a', 'extra'], ['status'], ['status', 'bad'],
    ['status', id, '--file', 'a'], ['status', id, '--command-id', randomUUID()], ['status', id, '--json', '--json'],
    ['plan', id, '--limit', '0'], ['plan', id, '--limit', '25'], ['plan', id, '--limit', '1.0'],
    ['plan', id, '--retry-failed'], ['pause', id, '--dry-run'], ['resume', id, '--mode', 'deep'],
    ['resume', id, '--client', 'codex'], ['resume', id, '--model', 'x'], ['resume', id, '--retry-failed', '--retry-failed'],
    ['cancel', id, '--command-id', 'bad'], ['reprioritize', id, 'task', '--priority', '101'],
    ['reprioritize', id, 'task'], ['approve-risk', id, 'task', '--reason', ' '],
    ['approve-risk', id, 'task', '--reason', '--json'], ['create', '--file=a'], ['plan', id, '--limit', '-1'],
    ['status', id, '--json=true'], ['status', id, '--'], ['pause', id, 'extra'],
    ['status', '11111111-1111-4111-8111-11111111111g'], ['pause', id, '--command-id', '11111111-1111-4111-8111-11111111111'],
    ['approve-risk', id, 'task', '--reason', 'x'.repeat(65537)], ['status', id, '\u0001']];
  let calls = 0;
  for (const args of cases) {
    const result = await projectCli([...args, ...(args.includes('--json') ? [] : ['--json'])], {
      loadSecrets: () => { calls++; throw Error('Must parse first'); },
      openStore: () => { calls++; throw Error('Must parse first'); }
    });
    assert.equal(result.exitCode, 1); assert.equal(result.report.result.status, 'invalid');
    assert.equal(result.report.result.code, 'project_arguments');
  }
  assert.equal(calls, 0);
});

test('Actual project CLI creates once, inspects and plans offline, persists manual controls across restart', async t => {
  const f = await fixture(t), commandId = '00000000-0000-0000-0000-000000000000';
  const created = f.invoke(['project', 'create', '--file', f.file, '--command-id', commandId]);
  assert.equal(created.exitCode, 0); const id = created.report.projectId;
  assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(created.report.schemaVersion, 1); assert.equal(created.report.revision, 1);
  const replay = f.invoke(['project', 'create', '--file', f.file, '--command-id', commandId]);
  assert.equal(replay.exitCode, 0); assert.equal(replay.report.projectId, id); assert.equal(replay.report.result.replayed, true);
  await writeFile(f.file, JSON.stringify({ ...f.input, title: 'Changed immutable payload' }));
  assert.equal(f.invoke(['project', 'create', '--file', f.file, '--command-id', commandId]).exitCode, 1);
  await writeFile(f.file, JSON.stringify(f.input));
  const status = f.invoke(['project', 'status', id]); assert.equal(status.exitCode, 0);
  assert.equal(status.report.result.completeness.tasks.total, 1); assert.equal(status.report.result.status, 'proposed');
  assert.match(f.invoke(['project', 'status', id], false).output, /tasks: returned 1 \/ total 1/);
  for (const dry of [[], ['--dry-run']]) {
    const plan = f.invoke(['project', 'plan', id, '--limit', '24', ...dry]);
    assert.equal(plan.exitCode, 0); assert.equal(plan.report.result.dryRun, true);
    assert.deepEqual(plan.report.result.taskIds, ['task-0']); assert.equal(plan.report.revision, 1);
  }
  const humanPlan = f.invoke(['project', 'plan', id, '--dry-run'], false);
  assert.equal(humanPlan.exitCode, 0); assert.match(humanPlan.output, /task-0/);
  const priority = f.invoke(['project', 'reprioritize', id, 'task-0', '--priority', '100', '--command-id', randomUUID()]);
  assert.equal(priority.exitCode, 0);
  assert.equal(f.invoke(['project', 'approve-risk', id, 'task-0', '--reason', 'Owned explicit approval', '--command-id', randomUUID()]).exitCode, 0);
  assert.equal(f.invoke(['project', 'pause', id, '--command-id', randomUUID()]).exitCode, 0);
  assert.equal(f.invoke(['project', 'status', id]).report.result.paused, true);
  assert.equal(f.invoke(['project', 'cancel', id, '--command-id', randomUUID()]).exitCode, 0);
  assert.equal(f.invoke(['project', 'status', id]).report.result.status, 'cancelled');
  assert.equal(f.invoke(['project', 'resume', id]).exitCode, 2);
  const { Store } = await import('../runtime/store.mjs'), store = new Store(f.home, {});
  try {
    assert.equal(store.listRuns().length, 0);
    const { openProjectStore } = await import('../runtime/project-store.mjs'), repo = await openProjectStore({ store });
    const snapshot = repo.snapshot(id); assert.equal(snapshot.tasks[0].priority, 100);
    assert.equal(snapshot.riskApprovals.length, 1); assert.equal(snapshot.riskApprovals[0].reason, 'Owned explicit approval');
    assert.equal(snapshot.currentAttempts.length, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM kodo_project_records WHERE kind='project'").get().n, 1);
  } finally { store.close(); }
});

test('Actual CLI risk approval unlocks only the current revision and plan dry-run writes no Attempt', async t => {
  const f = await fixture(t); f.input.tasks[0].riskApprovalRequired = true; await writeFile(f.file, JSON.stringify(f.input));
  const created = f.invoke(['project', 'create', '--file', f.file]), id = created.report.projectId;
  assert.equal(created.exitCode, 0);
  const blocked = f.invoke(['project', 'plan', id, '--dry-run']);
  assert.equal(blocked.exitCode, 2); assert.deepEqual(blocked.report.result.taskIds, []); assert.equal(blocked.report.revision, 1);
  const priority = f.invoke(['project', 'reprioritize', id, 'task-0', '--priority', '0'], false);
  assert.equal(priority.exitCode, 0); assert.match(priority.output, /Project:/);
  const approval = f.invoke(['project', 'approve-risk', id, 'task-0', '--reason', 'Owned risk decision'], false);
  assert.equal(approval.exitCode, 0);
  assert.deepEqual(f.invoke(['project', 'plan', id, '--limit', '1']).report.result.taskIds, ['task-0']);
  assert.equal(f.invoke(['project', 'reprioritize', id, 'task-0', '--priority', '1']).exitCode, 0);
  assert.equal(f.invoke(['project', 'plan', id]).exitCode, 2);
  const status = f.invoke(['project', 'status', id]);
  assert.equal(status.report.result.completeness.currentAttempts.total, 0);
});

test('Project resume alone enters the existing Engine and reopens the same quota Attempt without duplication', async t => {
  const f = await fixture(t), { projectCli } = await load();
  isolateProcess(t, f);
  const { Engine } = await import('../runtime/engine.mjs');
  let executions = 0, creations = 0, providerCalls = 0;
  const observedRuns = [];
  const denied = () => { providerCalls++; assert.fail('No native provider in the fixture'); };
  const ports = { home: f.home, secrets: {}, createEngine(values) {
    const engine = new Engine({ ...values, provider: { discoverProviders: denied, runSession: denied, analyzeGemini: denied, decideJev: denied } });
    const create = engine.createReserved.bind(engine);
    engine.createReserved = async (...args) => { creations++; return create(...args); };
    engine.run = async id => {
      executions++; const run = engine.store.getRun(id); observedRuns.push(run);
      return engine.store.updateRun(id, { state: 'waiting_limits' });
    };
    return engine;
  } };
  const created = await projectCli(['create', '--file', f.file, '--json'], ports), id = created.report.projectId;
  assert.equal(created.exitCode, 0);
  assert.equal((await projectCli(['pause', id, '--json'], ports)).exitCode, 0);
  assert.equal(executions, 0); assert.equal(creations, 0);
  for (const flags of [[], ['--retry-failed']]) {
    const resumed = await projectCli(['resume', id, ...flags, '--command-id', randomUUID(), '--json'], ports);
    assert.equal(resumed.exitCode, 2, resumed.output); assert.equal(resumed.report.result.status, 'waiting_limits');
  }
  assert.equal(executions, 2); assert.equal(creations, 1); assert.equal(providerCalls, 0);
  assert.equal(observedRuns[0].id, observedRuns[1].id);
  assert.equal(observedRuns[0].directorBinding.attemptId, observedRuns[1].directorBinding.attemptId);
  assert.equal(observedRuns[1].config.executionMode, 'quick'); assert.equal(observedRuns[1].config.maxTasks, 1);
  assert.equal(observedRuns[1].config.researchBudget, 0); assert.equal(observedRuns[1].config.repairRounds, 1);
  const { Store } = await import('../runtime/store.mjs'), store = new Store(f.home, {});
  try {
    assert.equal(store.listRuns().length, 1);
    const { openProjectStore } = await import('../runtime/project-store.mjs');
    const repo = await openProjectStore({ store });
    assert.equal(repo.snapshot(id).currentAttempts[0].number, 1);
    assert.equal(repo.snapshot(id).project.paused, false);
  } finally { store.close(); }
});

test('Project production authorizer rejects a forged interface before reservation or foreground Engine execution', async t => {
  const f = await fixture(t), { projectCli } = await load();
  isolateProcess(t, f);
  const { Engine } = await import('../runtime/engine.mjs');
  const artifact = path.join(f.dir, 'forged-interface.json'); await writeFile(artifact, '{}');
  f.input.tasks[0].interfaceRefs = [{ kind: 'interface', path: artifact, sha256: 'a'.repeat(64), runId: null, headSha: null }];
  await writeFile(f.file, JSON.stringify(f.input));
  let executions = 0;
  const ports = { home: f.home, secrets: {}, createEngine(values) {
    const engine = new Engine(values); engine.run = async () => { executions++; assert.fail('Unverified task must not execute'); }; return engine;
  } };
  const created = await projectCli(['create', '--file', f.file, '--json'], ports); assert.equal(created.exitCode, 0);
  const resumed = await projectCli(['resume', created.report.projectId, '--json'], ports);
  assert.equal(resumed.exitCode, 2); assert.equal(executions, 0);
  const { Store } = await import('../runtime/store.mjs'), store = new Store(f.home, {});
  try {
    const { openProjectStore } = await import('../runtime/project-store.mjs');
    const repo = await openProjectStore({ store }); const snapshot = repo.snapshot(created.report.projectId);
    assert.equal(snapshot.tasks[0].status, 'proposed'); assert.equal(snapshot.currentAttempts.length, 0); assert.equal(store.listRuns().length, 0);
  } finally { store.close(); }
});

test('Project retry-failed is explicit and preserves prior failed Attempt history and lower limits', async t => {
  const f = await fixture(t), { projectCli } = await load(); isolateProcess(t, f);
  const { Engine } = await import('../runtime/engine.mjs');
  let executions = 0, creations = 0;
  const ports = { home: f.home, secrets: {}, createEngine(values) {
    const engine = new Engine(values), create = engine.createReserved.bind(engine);
    engine.createReserved = async (...args) => { creations++; return create(...args); };
    engine.run = async id => {
      executions++; return engine.store.updateRun(id, { state: executions === 1 ? 'blocked' : 'waiting_limits' });
    };
    return engine;
  } };
  const created = await projectCli(['create', '--file', f.file, '--json'], ports), id = created.report.projectId;
  assert.equal(created.exitCode, 0);
  const resume = flags => projectCli(['resume', id, ...flags, '--json'], ports);
  assert.equal((await resume([])).report.result.status, 'blocked');
  assert.equal((await resume([])).exitCode, 2); assert.equal(creations, 1); assert.equal(executions, 1);
  assert.equal((await resume(['--retry-failed'])).report.result.status, 'waiting_limits');
  assert.equal(creations, 2); assert.equal(executions, 2);
  const { Store } = await import('../runtime/store.mjs'), store = new Store(f.home, {});
  try {
    const { openProjectStore } = await import('../runtime/project-store.mjs'), repo = await openProjectStore({ store });
    const snapshot = repo.snapshot(id), runs = store.listRuns();
    assert.equal(runs.length, 2); assert.equal(snapshot.currentAttempts[0].number, 2);
    assert.equal(new Set(runs.map(run => run.directorBinding.attemptId)).size, 2);
    assert.equal(runs.filter(run => run.state === 'blocked').length, 1);
    for (const run of runs) {
      assert.equal(run.config.maxTasks, 1); assert.equal(run.config.researchBudget, 0);
      assert.equal(run.config.repairRounds, 1); assert.equal(run.config.executionMode, 'quick');
    }
  } finally { store.close(); }
});

test('Project raw safety precedes Store and hashing for short, escaped, key and private-key inputs', async t => {
  const f = await fixture(t), { projectCli } = await load();
  const secret = 'fake"\\\nvalue';
  const cases = [
    { secrets: { GEMINI_API_KEY: secret }, input: { ...f.input, title: secret } },
    { secrets: { GEMINI_API_KEY: secret }, input: { ...f.input, [secret]: 'key leak' } },
    { secrets: { GEMINI_API_KEY: 'Q' }, input: { ...f.input, title: 'Q' } },
    { secrets: {}, input: { ...f.input, title: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----' } }
  ];
  let stores = 0;
  for (const row of cases) {
    await writeFile(f.file, JSON.stringify(row.input));
    const result = await projectCli(['create', '--file', f.file, '--json'], {
      loadSecrets: async () => row.secrets, openStore: () => { stores++; assert.fail('Unsafe raw input must not initialize state'); }
    });
    assert.equal(result.exitCode, 1); assert.equal(result.report.result.status, 'invalid');
    assert.ok(!result.output.includes(secret)); assert.ok(!result.output.includes('PRIVATE KEY'));
  }
  assert.equal(stores, 0);
});

test('Project invalid specification and missing input return invalid before opening state', async t => {
  const f = await fixture(t), { projectCli } = await load();
  const badParent = structuredClone(f.input); badParent.tasks[0].epicId = 'missing';
  const badDag = structuredClone(f.input); badDag.tasks[0].dependsOn = ['task-0'];
  let stores = 0;
  const ports = { secrets: {}, openStore: () => { stores++; assert.fail('Invalid specification must not initialize Store'); } };
  for (const input of [{ ...f.input, root: 'relative-root' }, badParent, badDag, { ...f.input, title: '' }]) {
    await writeFile(f.file, JSON.stringify(input));
    const result = await projectCli(['create', '--file', f.file, '--json'], ports);
    assert.equal(result.exitCode, 1); assert.equal(result.report.result.status, 'invalid');
  }
  assert.equal((await projectCli(['create', '--file', path.join(f.dir, 'absent.json'), '--json'], ports)).exitCode, 1);
  assert.equal(stores, 0);
});

test('Actual CLI guards stored output and manual command reasons with newly loaded fake known values', async t => {
  const f = await fixture(t), fake = 'owned-output-' + randomUUID();
  f.input.title = fake; await writeFile(f.file, JSON.stringify(f.input));
  const created = f.invoke(['project', 'create', '--file', f.file]); assert.equal(created.exitCode, 0);
  const bytes = await readFile(path.join(f.home, 'state.sqlite'));
  for (const args of [['status', created.report.projectId], ['plan', created.report.projectId],
    ['approve-risk', created.report.projectId, 'task-0', '--reason', fake]]) {
    const result = f.invoke(['project', ...args], true, { KODO_GEMINI_API_KEY: fake });
    assert.notEqual(result.exitCode, 0); assert.ok(!result.output.includes(fake));
  }
  assert.deepEqual(await readFile(path.join(f.home, 'state.sqlite')), bytes);
});

test('Actual CLI status remains bounded for a complete thousand-task backlog', async t => {
  const f = await fixture(t, 1000), created = f.invoke(['project', 'create', '--file', f.file]);
  assert.equal(created.exitCode, 0);
  const status = f.invoke(['project', 'status', created.report.projectId]);
  assert.equal(status.exitCode, 0); assert.equal(status.report.result.completeness.tasks.total, 1000);
  assert.equal(status.report.result.completeness.tasks.complete, true);
  assert.ok(Buffer.byteLength(status.output) < 4096);
  const planned = f.invoke(['project', 'plan', created.report.projectId, '--limit', '24']);
  assert.equal(planned.exitCode, 0); assert.equal(planned.report.result.taskIds.length, 1, 'Configured quick maxTasks remains lower');
});

test('Actual default CLI loads only isolated fake credentials before input hashing or project writes', async t => {
  const f = await fixture(t), fake = 'owned-fake-' + randomUUID() + '-"\\\n';
  await createCredentialStore({ directory: f.credentials, legacyDirectory: f.home, environment: {} }).save({ GEMINI_API_KEY: fake });
  const before = await readFile(path.join(f.credentials, process.platform === 'win32' ? 'credentials.dpapi.json' : 'credentials.json'));
  for (const input of [{ ...f.input, title: fake }, { ...f.input, [fake]: 'unsafe key' }]) {
    await writeFile(f.file, JSON.stringify(input));
    const result = f.invoke(['project', 'create', '--file', f.file]);
    assert.equal(result.exitCode, 1); assert.equal(result.report.result.status, 'invalid');
    assert.ok(!result.output.includes(fake)); await assert.rejects(access(path.join(f.home, 'state.sqlite')));
  }
  assert.deepEqual(await readFile(path.join(f.credentials, process.platform === 'win32' ? 'credentials.dpapi.json' : 'credentials.json')), before);
});

test('Actual invalid project flags bypass even a corrupt isolated credential home and create no state', async t => {
  const f = await fixture(t); await mkdir(f.credentials);
  await writeFile(path.join(f.credentials, process.platform === 'win32' ? 'credentials.dpapi.json' : 'credentials.json'), 'corrupt fake data');
  const invalid = f.invoke(['project', 'status', randomUUID(), '--bogus']);
  assert.equal(invalid.exitCode, 1); assert.equal(invalid.report.result.code, 'project_arguments');
  await assert.rejects(access(f.home));
});

test('Legacy catalog commands and help retain their CLI routes', async t => {
  const f = await fixture(t);
  const help = f.invoke(['--help'], false); assert.equal(help.exitCode, 0); assert.match(help.output, /kodo project create --file/);
  assert.equal(f.invoke(['list', 'skill']).exitCode, 0);
  assert.equal(f.invoke(['plan', 'pipelines/release-app']).exitCode, 0);
  assert.equal(f.invoke(['validate']).report.valid, true);
  await assert.rejects(access(f.home));
});

test('Legacy run status and audit keep their existing default CLI routes', async t => {
  const f = await fixture(t), { Store } = await import('../runtime/store.mjs');
  const store = new Store(f.home, {}), id = randomUUID();
  try { store.createRun({ id, task: 'Owned legacy run', project: f.root }); } finally { store.close(); }
  const status = f.invoke(['status', id]);
  assert.equal(status.exitCode, 0); assert.equal(status.report.id, id); assert.equal(status.report.state, 'created');
  const audit = f.invoke(['audit', id]);
  assert.equal(audit.exitCode, 0); assert.equal(audit.report.runId, id);
  assert.equal(audit.report.evidenceLevel, 'recorded-instructions');
});

test('Offline subprocess guard observes blocked network and native session entry points', async t => {
  const f = await fixture(t), provider = new URL('../runtime/providers.mjs', import.meta.url).href;
  const source = `const p = await import(${JSON.stringify(provider)});
    try { await p.discoverProviders(); } catch {}
    try { await p.runSession({}); } catch {}
    try { await fetch('https://offline.invalid'); } catch {}`;
  const result = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', source],
    { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /offline-attempts:1:2/);
});

test('Frozen independent Director oracle remains byte identical', async () => {
  assert.equal(createHash('sha256').update(await readFile(new URL('./project-director-oracle.test.mjs', import.meta.url))).digest('hex'),
    'fa0a150b981f9b0ea609e2204bf562a5b04f546f86dc74450ec541bf8635c7c5');
});
