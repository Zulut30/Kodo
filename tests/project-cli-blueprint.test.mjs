import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { compileBlueprint } from '../runtime/project-blueprint.mjs';
import { projectCli } from '../runtime/project-cli.mjs';
import { BLUEPRINT_ACTIONS, projectBlueprintCli } from '../runtime/project-cli-blueprint.mjs';
import { workerEnvironment } from '../runtime/security.mjs';

const cli = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blueprint');
const wave = { cadence: 'wave', integration: 'branch' };
const codes = report => report.result.findings.map(item => item.code);

// Same offline guard as tests/project-cli.test.mjs: network and native provider
// entry points fail closed and are counted.
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
      match => match + " globalThis.__projectProviderAttempt(); ") };
    return loaded;
  } });
  globalThis.__projectProviderAttempt = () => { providers++; throw Error('Offline provider guard'); };
  process.on('exit', () => console.error('offline-attempts:' + network + ':' + providers));
`);

async function tree(dir, prefix = '') {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!prefix && entry.name === '.git') continue; // Git may refresh its own index; the working tree may not change.
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push([`${name}/`], ...(await tree(path.join(dir, entry.name), `${name}/`)));
    else
      result.push([
        name,
        createHash('sha256')
          .update(await readFile(path.join(dir, entry.name)))
          .digest('hex'),
      ]);
  }
  return result;
}

async function writeBlueprint(root, overlay) {
  const dir = path.join(root, '.kodo', 'blueprint');
  await cp(path.join(fixtures, 'valid'), dir, { recursive: true });
  if (overlay) await cp(path.join(fixtures, 'invalid', overlay), dir, { recursive: true });
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  spec.root = root;
  await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  return dir;
}

/** A project root with an owned Git repository and a Kodo state home outside it. */
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-blueprint-cli-')));
  const home = path.join(dir, 'state'),
    isolated = path.join(dir, 'empty-home');
  await mkdir(isolated);
  const env = {
    ...workerEnvironment(),
    HOME: isolated,
    USERPROFILE: isolated,
    LOCALAPPDATA: isolated,
    XDG_CONFIG_HOME: isolated,
    KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(dir, 'credentials'),
    KODO_WORKTREE_HOME: path.join(dir, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  let roots = 0;
  const root = async () => {
    const directory = path.join(dir, `repo-${roots++}`);
    await mkdir(directory);
    await writeFile(
      path.join(directory, 'kodo.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        client: 'codex',
        executionMode: 'quick',
        commands: { test: [], build: [], deploy: [], smoke: [] },
        delivery: { enabled: false },
        security: { enabled: false },
        uiVerification: { enabled: false },
        architecture: { enabled: false },
      }),
    );
    const git = (...args) => execFileSync('git', args, { cwd: directory, env, windowsHide: true });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Owned blueprint CLI');
    git('config', 'user.email', 'blueprint-cli@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    git('add', '.');
    git('commit', '-m', 'Owned fixture');
    return directory;
  };
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await rm(dir, { recursive: true, force: true });
  });
  const ports = (extra = {}) => ({ home, secrets: {}, architecture: null, knowledge: null, ...extra });
  const run = async (args, extra) => {
    const result = await projectCli([...args, '--json'], ports(extra));
    return { ...result, report: JSON.parse(result.output) };
  };
  // Direct store access with a permissive authorizer: only to stage accepted work.
  const direct = async () => {
    const store = new Store(home, {});
    stores.push(store);
    const repo = await openProjectStore({ store, contracts, authorizeTransition: async () => undefined });
    return { store, repo };
  };
  return { dir, home, env, root, ports, run, direct };
}

const fakeEngine =
  provider =>
  ({ store, secrets }) =>
    new Engine({ store, secrets, provider });

function blueprintWriter() {
  const calls = [];
  return {
    calls,
    async runSession(request) {
      calls.push(request);
      await writeBlueprint(request.cwd);
      return { sessionId: 'fake-bootstrap', model: 'fake-model', output: { status: 'written', summary: 'Чертёж' } };
    },
  };
}

const proof = { id: 'works', text: 'Observable result works', evidenceKinds: ['checks'] };
const evidence = {
  kind: 'checks',
  runId: null,
  headSha: null,
  path: '/srv/kodo-evidence/checks.json',
  sha256: 'a'.repeat(64),
};
const mapping = { criterionId: 'works', refs: [evidence.sha256], actor: 'reviewer', reason: 'Checked result' };
const taskSpec = (id, extra = {}) => ({
  id,
  epicId: 'e',
  title: `Task ${id}`,
  description: `Deliver observable behavior ${id}`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`src/${id}`],
  acceptance: [proof],
  interfaceRefs: [],
  priority: 50,
  userValue: 3,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...extra,
});
const milestone = (extra = {}) => ({
  milestone: { id: 'm2', title: 'Second milestone', acceptance: [proof], releaseRequired: false },
  epics: [{ id: 'e2', milestoneId: 'm2', title: 'Second epic', acceptance: [proof] }],
  tasks: [
    taskSpec('c', { epicId: 'e2', dependsOn: ['a'] }),
    taskSpec('d', { epicId: 'e2', owner: 'reviewer', dependsOn: ['c'] }),
  ],
  ...extra,
});

/** An accepted wave project, staged through real forward transitions. */
async function acceptedProject(f) {
  const root = await f.root();
  const { repo } = await f.direct();
  const command = (projectId, action) => ({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId,
    expectedRevision: projectId ? repo.snapshot(projectId).revision : null,
    actor: 'owner',
    reason: 'Stage accepted wave project',
    action,
  });
  const spec = {
    schemaVersion: 1,
    id: 'accepted',
    root,
    title: 'Accepted wave project',
    definitionOfDone: [proof],
    constraints: ['Only assigned work'],
    businessContext: 'Owned fixture',
    architectureRefs: [],
    execution: { ...wave },
    milestones: [{ id: 'm', title: 'First milestone', acceptance: [proof], releaseRequired: false }],
    epics: [{ id: 'e', milestoneId: 'm', title: 'First epic', acceptance: [proof] }],
    tasks: [taskSpec('a')],
  };
  const { projectId } = await repo.apply(command(null, { op: 'create', spec }));
  const drive = async (kind, id, states) => {
    for (const to of states) {
      const own = to === 'accepted' ? { evidence: [evidence], mappings: [mapping] } : { evidence: [], mappings: [] };
      await repo.apply(command(projectId, { op: 'transition', kind, id, to, ...own }));
    }
  };
  await repo.apply(command(projectId, { op: 'reserveAttempt', taskId: 'a', retryFailed: false }));
  const attempt = repo.snapshot(projectId).currentAttempts.find(row => row.taskId === 'a');
  await drive('task', 'a', ['ready', 'running', 'verifying', 'integrated']);
  await drive('attempt', attempt.id, ['running', 'verifying', 'integrated', 'accepted']);
  await drive('task', 'a', ['accepted']);
  for (const [kind, id] of [
    ['epic', 'e'],
    ['milestone', 'm'],
    ['project', projectId],
  ])
    await drive(kind, id, ['ready', 'running', 'verifying', 'integrated', 'accepted']);
  const snapshot = repo.snapshot(projectId);
  assert.equal(snapshot.project.status, 'accepted');
  return { root, projectId, snapshot, repo };
}

test('blueprint actions reject invalid arguments before credentials, state or providers', async () => {
  const id = randomUUID();
  const cases = [
    ['bootstrap'],
    ['bootstrap', 'Идея'],
    ['bootstrap', 'Идея', '--root'],
    ['bootstrap', 'Идея', 'ещё', '--root', 'r'],
    ['bootstrap', ' ', '--root', 'r'],
    ['bootstrap', 'x'.repeat(65537), '--root', 'r'],
    ['bootstrap', 'Идея', '--root', 'r', '--prepare', '--client', 'codex'],
    ['bootstrap', 'Идея', '--root', 'r', '--prepare', '--model', 'm'],
    ['bootstrap', 'Идея', '--root', 'r', '--client', 'api'],
    ['bootstrap', 'Идея', '--root', 'r', '--model', 'bad model'],
    ['bootstrap', 'Идея', '--root', 'r', '--command-id', id],
    ['bootstrap', 'Идея', '--root', 'r', '--root', 'r'],
    ['bootstrap', 'Идея', '--root', 'r', '--prepare', '--prepare'],
    ['apply-spec'],
    ['apply-spec', '--root', 'r', 'extra'],
    ['apply-spec', '--root', 'r', '--command-id', 'bad'],
    ['apply-spec', '--root', 'r', '--prepare'],
    ['apply-spec', '--root', 'r', '--file'],
    ['extend', id],
    ['extend', 'bad', 'Фича'],
    ['extend', id, 'Фича', 'ещё'],
    ['extend', id, 'Фича', '--root', 'r'],
    ['extend', id, 'Фича', '--prepare', '--client', 'codex'],
    ['extend', id, 'Фича', '--prepare', '--command-id', id],
    ['append-milestone', id],
    ['append-milestone', '--file', 'm.json'],
    ['append-milestone', id, '--file', 'm.json', '--prepare'],
    ['append-milestone', id, 'extra', '--file', 'm.json'],
    ['append-milestone', id, '--file=m.json'],
    ['append-milestone', id, '--file', 'm.json', '\u0001'],
  ];
  let calls = 0;
  const forbidden = () => {
    calls++;
    throw Error('Must parse first');
  };
  for (const args of cases) {
    const result = await projectCli([...args, '--json'], {
      loadSecrets: forbidden,
      openStore: forbidden,
      createEngine: forbidden,
      provider: { runSession: forbidden },
    });
    assert.equal(result.exitCode, 1, JSON.stringify(args).slice(0, 120));
    assert.deepEqual(JSON.parse(result.output), {
      schemaVersion: 1,
      projectId: null,
      revision: null,
      result: { status: 'invalid', code: 'project_arguments' },
    });
  }
  assert.equal(calls, 0);
  assert.deepEqual(BLUEPRINT_ACTIONS, ['bootstrap', 'apply-spec', 'extend', 'append-milestone']);
  const direct = await projectBlueprintCli(['status', id], { loadSecrets: forbidden });
  assert.equal(direct.exitCode, 1);
  assert.equal(calls, 0);
});

test('bootstrap --prepare writes the context bundle only to KODO_HOME', async t => {
  const f = await fixture(t);
  const root = await f.root();
  const before = await tree(root);
  const result = spawnSync(
    process.execPath,
    ['--import', guard, cli, 'project', 'bootstrap', 'Сервис заметок с поиском', '--root', root, '--prepare', '--json'],
    { cwd: root, env: f.env, encoding: 'utf8', timeout: 60000, windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /offline-attempts:0:0/);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.projectId, null);
  assert.equal(report.result.status, 'prepared');
  const { bundle } = report.result;
  assert.match(bundle.id, /^bootstrap-/);
  assert.equal(path.dirname(bundle.dir), path.join(await realpath(f.home), 'bootstrap'));
  assert.deepEqual(bundle.files, [
    'context.md',
    'rules.md',
    'templates/PROJECT.md',
    'templates/interfaces/module.md',
    'templates/spec.json',
  ]);
  assert.match(await readFile(path.join(bundle.dir, 'context.md'), 'utf8'), /Сервис заметок с поиском/);
  assert.equal(report.result.summary.root, root);
  assert.equal(report.result.blueprint, path.join(root, '.kodo', 'blueprint'));
  // The hints call the CLI that issued them, by its absolute entry.
  const apply = report.result.commands[0].command;
  const commandId = / --command-id ([a-f0-9-]{36}) --json$/.exec(apply)?.[1];
  assert.ok(commandId, apply);
  assert.equal(apply, `node "${cli}" project apply-spec --root "${root}" --command-id ${commandId} --json`);
  assert.ok(report.result.next.includes(`Проверь и зарегистрируй проект: ${apply}`));
  const bare = /\bkodo project\b/;
  assert.ok(bare.test('Проверь: kodo project apply-spec --json'), 'the check sees a bare kodo command');
  assert.ok(report.result.next.every(line => !bare.test(line)));
  // The machine field holds only the command: it runs as is in the platform shell.
  assert.deepEqual(
    report.result.commands.map(item => item.command),
    [apply],
  );
  assert.ok(report.result.commands.every(item => typeof item.why === 'string' && item.why.length > 0));
  const env = { ...f.env };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [path.dirname(process.execPath), env[pathKey]].filter(Boolean).join(path.delimiter);
  const ran = spawnSync(apply, { shell: true, cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.equal(JSON.parse(ran.stdout).result.code, 'blueprint_findings', 'apply-spec ran and found no blueprint yet');
  assert.deepEqual(await tree(root), before, 'the repository is unchanged');
});

test('bootstrap runs one native session through the Engine provider and compiles the blueprint', async t => {
  const f = await fixture(t);
  const root = await f.root();
  const provider = blueprintWriter();
  const { exitCode, report } = await f.run(
    ['bootstrap', 'Сервис заметок', '--root', root, '--client', 'claude-code', '--model', 'sonnet'],
    { createEngine: fakeEngine(provider) },
  );
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(provider.calls.length, 1);
  const [request] = provider.calls;
  assert.equal(request.client, 'claude-code');
  assert.equal(request.model, 'sonnet');
  assert.equal(request.cwd, root);
  assert.equal(request.readOnly, false);
  assert.equal(report.projectId, null);
  assert.equal(report.result.status, 'compiled');
  assert.equal(report.result.session.sessionId, 'fake-bootstrap');
  assert.deepEqual(report.result.modules.waveZero, ['scaffold', 'test-bench']);
  assert.deepEqual(
    report.result.modules.milestones.map(item => item.id),
    ['foundation', 'mvp'],
  );
  assert.ok(report.result.next.some(line => line.includes('apply-spec')));
  assert.match(report.result.commands[0].command, / --command-id [a-f0-9-]{36} --json$/);
  assert.equal((await compileBlueprint(root)).ok, true);

  const empty = await f.root();
  const silent = { runSession: async () => ({ output: { status: 'blocked', summary: 'Неясно' } }) };
  const blocked = await f.run(['bootstrap', 'x', '--root', empty, '--client', 'codex'], {
    createEngine: fakeEngine(silent),
  });
  assert.equal(blocked.exitCode, 1);
  assert.deepEqual(codes(blocked.report), ['blueprint_session_blocked', 'blueprint_missing']);
  const failing = {
    runSession: async () => {
      throw Object.assign(new Error('subscription unavailable'), { code: 'unavailable' });
    },
  };
  const failed = await f.run(['bootstrap', 'x', '--root', empty, '--client', 'codex'], {
    createEngine: fakeEngine(failing),
  });
  assert.equal(failed.exitCode, 2);
  assert.deepEqual(failed.report.result, { status: 'blocked', code: 'project_blocked' });
});

test('apply-spec creates a wave project with verifiable interfaces and replays by command id', async t => {
  const f = await fixture(t);
  const root = await f.root();
  const dir = await writeBlueprint(root);
  const prefix = `node "${cli}"`;
  const prepared = await f.run(['bootstrap', 'Notes', '--root', root, '--prepare'], { cli: prefix });
  assert.equal(prepared.exitCode, 0);
  const apply = prepared.report.result.commands[0].command;
  const env = { ...f.env };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [path.dirname(process.execPath), env[pathKey]].filter(Boolean).join(path.delimiter);
  const runApply = () => {
    const ran = spawnSync(apply, { shell: true, cwd: root, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(ran.error, undefined);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    return JSON.parse(ran.stdout);
  };
  const report = runApply();
  assert.equal(report.result.status, 'created');
  // Next steps with the caller's CLI: the managed linter for workers' self-check, then the first wave.
  const hint = text =>
    assert.ok(
      report.result.next.some(line => line.includes(text)),
      text,
    );
  hint(`${prefix} tools install oxlint --project "${root}" --json`);
  hint(`${prefix} project next-wave ${report.projectId} --host t3 --limit 3 --json`);
  assert.deepEqual(
    report.result.commands.map(item => item.command),
    [
      `${prefix} tools install oxlint --project "${root}" --json`,
      `${prefix} tools install typescript --project "${root}" --json`,
      `${prefix} project next-wave ${report.projectId} --host t3 --limit 3 --json`,
    ],
  );
  // ci feedback succeeds with feedback_ready; a missing tool is a blocker, never a success.
  assert.ok(
    report.result.next.some(line => line.includes('blocked') && line.includes('feedback_ready')),
    'a missing tool is named a blocker',
  );
  assert.ok(report.result.next.every(line => !line.includes('passed')));
  assert.equal(report.result.replayed, false);
  assert.deepEqual(report.result.execution, wave);
  assert.deepEqual(report.result.modules.waveZero, ['scaffold', 'test-bench']);
  assert.deepEqual(
    report.result.modules.milestones.find(item => item.id === 'mvp').epics.map(epic => [epic.id, epic.tasks]),
    [
      ['api', ['api-module']],
      ['release-review', ['mvp-review']],
      ['storage', ['storage-module']],
      ['web', ['web-module', 'web-ui-qa']],
    ],
  );
  const projectId = report.projectId;

  const { store, repo } = await f.direct();
  const snapshot = repo.snapshot(projectId);
  assert.deepEqual(snapshot.project.execution, wave);
  assert.equal(snapshot.revision, report.revision);
  const engine = new Engine({ store, secrets: {} });
  const home = await realpath(f.home);
  const refs = snapshot.tasks.flatMap(task => task.interfaceRefs);
  assert.ok(refs.length >= 3);
  for (const ref of refs) {
    assert.equal(ref.kind, 'interface');
    assert.equal(ref.runId, null);
    assert.equal(ref.headSha, null);
    assert.ok(ref.path.startsWith(home + path.sep), 'interface evidence lives in Kodo home');
    await engine.assertEvidence(ref);
    const envelope = JSON.parse(await readFile(ref.path, 'utf8'));
    assert.equal(envelope.kind, 'interface');
    assert.equal(envelope.value.text, await readFile(path.join(dir, envelope.value.source), 'utf8'));
  }
  assert.deepEqual(
    report.result.interfaces.map(item => item.module),
    ['api', 'storage', 'web'],
  );

  // Wave 0 without dependencies is offered; every other task waits for dependencies.
  const plan = await f.run(['plan', projectId]);
  assert.equal(plan.exitCode, 0, JSON.stringify(plan.report));
  assert.deepEqual(plan.report.result.taskIds, ['scaffold']);
  const blocked = new Map(plan.report.result.blocked.map(row => [row.taskId, row.reasons]));
  assert.equal(blocked.size, 6);
  for (const reasons of blocked.values()) {
    assert.ok(
      reasons.some(reason => reason.startsWith('dependency_not_accepted:')),
      reasons.join(),
    );
    assert.ok(!reasons.includes('interfaces_unverified'));
  }

  const again = runApply();
  assert.equal(again.projectId, projectId);
  assert.equal(again.result.status, 'replayed');
  assert.equal(again.result.replayed, true);
  assert.equal(repo.snapshot(projectId).revision, snapshot.revision);
});

test('apply-spec reports blueprint findings with exit 1 before opening state', async t => {
  const f = await fixture(t);
  const root = await f.root();
  await writeBlueprint(root, 'parallel-overlap');
  let opened = 0;
  const { exitCode, report } = await f.run(['apply-spec', '--root', root], {
    openStore: () => {
      opened++;
      throw Error('Findings must stop before state');
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(report.result.status, 'invalid');
  assert.equal(report.result.code, 'blueprint_findings');
  assert.deepEqual(codes(report), ['blueprint_parallel_overlap']);
  assert.deepEqual(report.result.findings[0].taskIds, ['storage-module', 'api-module']);
  assert.ok(!JSON.stringify(report).includes(root), 'findings carry no project paths');
  assert.equal(opened, 0);
  assert.equal(existsSync(f.home), false);

  const missing = await f.run(['apply-spec', '--root', root, '--file', path.join(f.dir, 'absent.json')]);
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(codes(missing.report), ['blueprint_missing']);
});

test('append-milestone appends to an accepted wave project and keeps prior history', async t => {
  const f = await fixture(t);
  const { projectId, snapshot: closed, repo } = await acceptedProject(f);
  const file = path.join(f.dir, 'milestone.json');

  await writeFile(file, JSON.stringify(milestone({ tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['x'] })] })));
  const invalid = await f.run(['append-milestone', projectId, '--file', file]);
  assert.equal(invalid.exitCode, 1);
  assert.deepEqual(codes(invalid.report), ['milestone_dependency_unknown']);
  assert.equal(repo.snapshot(projectId).revision, closed.revision);

  await writeFile(path.join(f.dir, 'broken.json'), '{');
  const broken = await f.run(['append-milestone', projectId, '--file', path.join(f.dir, 'broken.json')]);
  assert.equal(broken.exitCode, 1);
  assert.deepEqual(codes(broken.report), ['milestone_invalid_json']);

  await writeFile(file, JSON.stringify(milestone()));
  const { exitCode, report } = await f.run(['append-milestone', projectId, '--file', file]);
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(report.projectId, projectId);
  assert.equal(report.revision, closed.revision + 1);
  assert.equal(report.result.status, 'appended');
  assert.equal(report.result.milestone, 'm2');
  assert.deepEqual(report.result.tasks, ['c', 'd']);
  const opened = repo.snapshot(projectId);
  assert.equal(opened.project.status, 'running');
  assert.equal(opened.project.reopened.length, 1);
  assert.equal(opened.project.reopened[0].status, 'accepted');
  for (const key of ['milestones', 'epics', 'tasks'])
    for (const row of closed[key])
      assert.deepEqual(
        opened[key].find(item => item.id === row.id),
        row,
      );
  assert.deepEqual(
    opened.tasks.filter(task => ['c', 'd'].includes(task.id)).map(task => task.status),
    ['proposed', 'proposed'],
  );

  // A repeated append is refused by the checks; nothing is appended twice.
  const repeated = await f.run(['append-milestone', projectId, '--file', file]);
  assert.equal(repeated.exitCode, 1);
  assert.ok(codes(repeated.report).includes('milestone_id_conflict'));
  assert.equal(repo.snapshot(projectId).revision, opened.revision);
});

test('extend prepares a feature bundle from the snapshot or appends a session milestone', async t => {
  const f = await fixture(t);
  const prepared = await acceptedProject(f);
  const before = await tree(prepared.root);
  const bundle = await f.run(['extend', prepared.projectId, 'Добавить теги', '--prepare'], {
    cli: `node "${cli}"`,
  });
  assert.equal(bundle.exitCode, 0, JSON.stringify(bundle.report));
  assert.ok(
    bundle.report.result.next.some(line =>
      line.includes(`node "${cli}" project append-milestone ${prepared.projectId} --file "`),
    ),
  );
  const id = / --command-id ([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}) --json$/.exec(
    bundle.report.result.commands[0].command,
  )?.[1];
  assert.ok(id);
  assert.deepEqual(
    bundle.report.result.commands.map(item => item.command),
    [
      `node "${cli}" project append-milestone ${prepared.projectId} --file "${path.join(bundle.report.result.bundle.dir, 'milestone.json')}" --command-id ${id} --json`,
    ],
  );
  assert.equal(bundle.report.projectId, prepared.projectId);
  assert.equal(bundle.report.revision, prepared.snapshot.revision);
  assert.equal(bundle.report.result.status, 'prepared');
  assert.match(bundle.report.result.bundle.id, /^extend-/);
  assert.equal(path.dirname(bundle.report.result.bundle.dir), path.join(await realpath(f.home), 'bootstrap'));
  assert.equal(
    bundle.report.result.template,
    path.join(bundle.report.result.bundle.dir, 'templates', 'milestone.json'),
  );
  assert.ok(existsSync(bundle.report.result.template));
  assert.ok(bundle.report.result.next.some(line => line.includes('append-milestone')));
  assert.deepEqual(await tree(prepared.root), before, 'the repository is unchanged');
  assert.equal(prepared.repo.snapshot(prepared.projectId).revision, prepared.snapshot.revision);

  const target = await acceptedProject(f);
  const calls = [];
  const provider = {
    async runSession(request) {
      calls.push(request);
      return {
        sessionId: 'fake-extend',
        output: { status: 'proposed', summary: 'Теги', milestone: JSON.stringify(milestone()) },
      };
    },
  };
  const { exitCode, report } = await f.run(['extend', target.projectId, 'Добавить теги', '--client', 'codex'], {
    createEngine: fakeEngine(provider),
  });
  assert.equal(exitCode, 0, JSON.stringify(report));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].readOnly, true);
  assert.equal(calls[0].cwd, target.root);
  assert.equal(report.result.status, 'appended');
  assert.equal(report.result.session.sessionId, 'fake-extend');
  assert.equal(target.repo.snapshot(target.projectId).project.status, 'running');
  assert.ok(target.repo.snapshot(target.projectId).milestones.some(item => item.id === 'm2'));
});

test('bootstrap and extend redact a CLI known secret found in repository metadata', async t => {
  const f = await fixture(t);
  const secret = 'kodo-cli-known-secret-4d2c8e1f9a';
  const root = await f.root();
  await writeFile(path.join(root, `config-${secret}.txt`), '');
  const secrets = { token: secret };
  const prepared = await f.run(['bootstrap', 'Сервис заметок', '--root', root, '--prepare'], { secrets });
  assert.equal(prepared.exitCode, 0, JSON.stringify(prepared.report));
  const context = await readFile(path.join(prepared.report.result.bundle.dir, 'context.md'), 'utf8');
  assert.ok(!context.includes(secret), 'context.md carries no known secret');
  assert.match(context, /config-\[REDACTED\]\.txt/);
  assert.equal(prepared.report.result.summary.redacted, true);

  const provider = blueprintWriter();
  const generated = await f.run(['bootstrap', 'Сервис заметок', '--root', root], {
    secrets,
    createEngine: fakeEngine(provider),
  });
  assert.equal(generated.exitCode, 0, JSON.stringify(generated.report));
  assert.equal(provider.calls.length, 1);
  assert.ok(!provider.calls[0].prompt.includes(secret), 'the native session never receives the secret');

  const accepted = await acceptedProject(f);
  const architecture = { modules: [{ id: 'core', roots: [`src/${secret}`] }], edges: [] };
  const extended = await f.run(['extend', accepted.projectId, 'Добавить теги', '--prepare'], {
    secrets,
    architecture,
  });
  assert.equal(extended.exitCode, 0, JSON.stringify(extended.report));
  for (const name of extended.report.result.bundle.files)
    assert.ok(!(await readFile(path.join(extended.report.result.bundle.dir, name), 'utf8')).includes(secret), name);
});

test('apply-spec requires a committed Git root with no changes outside the blueprint', async t => {
  const f = await fixture(t);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: f.env, windowsHide: true });
  const gitCodes = async (root, extra) => {
    const result = await f.run(['apply-spec', '--root', root], extra);
    assert.equal(result.exitCode, 1, JSON.stringify(result.report));
    assert.equal(result.report.result.code, 'blueprint_findings');
    assert.ok(!JSON.stringify(result.report).includes(root), 'findings carry no project paths');
    return codes(result.report);
  };
  const plain = path.join(f.dir, 'plain');
  await mkdir(plain);
  await writeBlueprint(plain);
  let opened = 0;
  const openStore = () => {
    opened++;
    throw Error('Git findings must stop before state');
  };
  assert.deepEqual(await gitCodes(plain, { openStore }), ['blueprint_git_required']);

  const empty = path.join(f.dir, 'no-commit');
  await mkdir(empty);
  git(empty, 'init', '-b', 'main');
  await writeBlueprint(empty);
  assert.deepEqual(await gitCodes(empty, { openStore }), ['blueprint_git_required']);

  const nested = path.join(await f.root(), 'packages', 'app');
  await mkdir(nested, { recursive: true });
  await writeBlueprint(nested);
  assert.deepEqual(await gitCodes(nested, { openStore }), ['blueprint_git_required']);

  const dirty = await f.root();
  await writeBlueprint(dirty);
  await writeFile(path.join(dirty, 'kodo.config.json'), '{}');
  await writeFile(path.join(dirty, 'draft.txt'), 'untracked');
  const dirtyResult = await f.run(['apply-spec', '--root', dirty], { openStore });
  assert.deepEqual(codes(dirtyResult.report), ['blueprint_git_required']);
  assert.match(dirtyResult.report.result.findings[0].message, /2/);
  assert.equal(opened, 0);

  // Blueprint findings and the Git rule are reported together.
  const both = path.join(f.dir, 'both');
  await mkdir(both);
  await writeBlueprint(both, 'parallel-overlap');
  assert.deepEqual(await gitCodes(both, { openStore }), ['blueprint_parallel_overlap', 'blueprint_git_required']);

  // Ignored files and the uncommitted blueprint itself do not block registration.
  git(dirty, 'checkout', '--', 'kodo.config.json');
  await writeFile(path.join(dirty, '.git', 'info', 'exclude'), 'draft.txt\n');
  const created = await f.run(['apply-spec', '--root', dirty]);
  assert.equal(created.exitCode, 0, JSON.stringify(created.report));
  assert.equal(created.report.result.status, 'created');
});

test('bootstrap and apply-spec refuse a root a shell would expand and an unusable CLI port before any state', async t => {
  const f = await fixture(t);
  const unsafe = message => assert.match(message, /переименуйте или переместите/);
  for (const name of ['repo $(calc)', 'repo $x', 'repo %PATH%', 'repo `id`', 'repo !x!']) {
    const root = path.join(f.dir, name);
    await mkdir(root);
    const result = await f.run(['bootstrap', 'Заметки', '--root', root, '--prepare']);
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.report.result.reason, 'project_path_unsafe', name);
    unsafe(result.report.result.message);
  }
  // A committed repository moved under such a name: no evidence and no project are written.
  const moved = path.join(f.dir, 'moved $x');
  await rename(await f.root(), moved);
  await writeBlueprint(moved);
  const applied = await f.run(['apply-spec', '--root', moved]);
  assert.equal(applied.exitCode, 1, JSON.stringify(applied.report));
  assert.equal(applied.report.result.reason, 'project_path_unsafe');
  // A null CLI port is refused, not replaced with kodo.
  const plain = await f.root();
  const refused = await f.run(['bootstrap', 'Заметки', '--root', plain, '--prepare'], { cli: null });
  assert.equal(refused.exitCode, 2);
  assert.equal(refused.report.result.reason, 'project_cli_invalid');
  await assert.rejects(access(f.home), 'no bundle, evidence or Store was written');
});

test('extend --prepare checks the milestone file of its bundle before creating the bundle directory', async t => {
  const f = await fixture(t);
  const prepared = await acceptedProject(f);
  // Kodo home itself is safe, but its bundle folder resolves into a directory cmd would expand.
  const target = path.join(f.dir, 'bundles %PATH%');
  await mkdir(target);
  await symlink(target, path.join(f.home, 'bootstrap'), 'junction');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.run(['extend', prepared.projectId, 'Теги', '--prepare']);
    assert.equal(result.exitCode, 1, JSON.stringify(result.report));
    assert.equal(result.report.result.reason, 'project_path_unsafe');
    assert.deepEqual(await readdir(target), [], 'no bundle is written, a repeat adds none');
  }
});
