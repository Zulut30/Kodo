import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsPromises, {
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
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gitBoundary } from '../runtime/command.mjs';
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
async function acceptedProject(f, task = {}) {
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
    tasks: [taskSpec('a', task)],
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
    ['bootstrap', 'Идея', '--root', 'r', '--prepare', '--client', 'gpt'],
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
    'templates/kodo.config.json',
  ]);
  assert.match(await readFile(path.join(bundle.dir, 'context.md'), 'utf8'), /Сервис заметок с поиском/);
  // The verification policy of every wave comes from the committed kodo.config.json: it is created
  // and committed (client, commands.test) before apply-spec registers the project.
  const config = report.result.next.findIndex(line => line.includes('kodo.config.json'));
  const register = report.result.next.findIndex(line => line.includes('project apply-spec --root'));
  assert.ok(config >= 0 && config < register, report.result.next.join('\n'));
  for (const text of [
    'templates',
    'проверь существующий',
    'client',
    'commands.test',
    'закоммить',
    'blueprint_config_missing',
  ])
    assert.ok(report.result.next[config].includes(text), text);
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
  // The template of the coordinator's config names the client the session ran with.
  const template = path.join(
    await realpath(f.home),
    'bootstrap',
    report.result.bundle.id,
    'templates',
    'kodo.config.json',
  );
  assert.equal(JSON.parse(await readFile(template, 'utf8')).client, 'claude-code');
  assert.ok(report.result.next.some(line => line.includes('kodo.config.json') && line.includes(template)));

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

test('bootstrap --prepare --client names the gate client of the kodo.config.json template', async t => {
  // Live T3 smoke of 1.0.1: --prepare refused --client (project_arguments), so a Claude-only user
  // got a template with codex. The bundle's template now carries the chosen client.
  const f = await fixture(t);
  const root = await f.root();
  for (const client of ['claude-code', 'codex']) {
    const prepared = await f.run(['bootstrap', 'Notes', '--root', root, '--prepare', '--client', client]);
    assert.equal(prepared.exitCode, 0, JSON.stringify(prepared.report));
    assert.equal(prepared.report.result.status, 'prepared');
    const template = JSON.parse(
      await readFile(path.join(prepared.report.result.bundle.dir, 'templates', 'kodo.config.json'), 'utf8'),
    );
    assert.equal(template.client, client);
  }
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

function fixtureGit(root, env) {
  return (...args) => {
    const guarded = gitBoundary(args, { ...env, LC_ALL: 'C' });
    return execFileSync('git', guarded.args, {
      cwd: root,
      env: guarded.env,
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  };
}

// Both commits are clean and plan a new .rs file in an existing nested package.
// Only the registration tip has its pinned toolchain. The command id is stable across attempts.
async function registrationFixture(t, { refFormat, linked = false } = {}) {
  const f = await fixture(t);
  if (refFormat) f.env.GIT_DEFAULT_REF_FORMAT = refFormat;
  const main = await f.root();
  const mainGit = fixtureGit(main, f.env);
  const root = linked ? path.join(f.dir, 'linked') : main;
  if (linked) mainGit('worktree', 'add', '-qb', 'registration', root);
  const git = fixtureGit(root, f.env);
  const specFile = path.join(await writeBlueprint(root), 'spec.json');
  const spec = JSON.parse(await readFile(specFile, 'utf8'));
  spec.tasks.find(task => task.id === 'storage-module').writePaths = ['native/engine/src/planned.rs'];
  await writeFile(specFile, JSON.stringify(spec));
  await mkdir(path.join(root, 'native', 'engine'), { recursive: true });
  await writeFile(path.join(root, 'native', 'engine', 'Cargo.toml'), '[package]\nname="engine"\nversion="0.1.0"\n');
  git('add', '.');
  git('commit', '-qm', 'Plan a new Rust source');
  git('branch', 'without-pin');
  await writeFile(
    path.join(root, 'rust-toolchain.toml'),
    '[toolchain]\nchannel="1.85.1"\ncomponents=["clippy","rustfmt"]\n',
  );
  git('add', 'rust-toolchain.toml');
  git('commit', '-qm', 'Pin toolchain');
  const args = ['apply-spec', '--root', root, '--command-id', randomUUID()];
  return { root, home: f.home, direct: f.direct, git, mainGit, apply: extra => f.run(args, extra) };
}

function duringTreeRead(t, name, switchHead, restore) {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const reading = command === 'git' && args.includes('ls-tree') && args.at(-1) === name;
    if (reading) switchHead();
    const child = spawn(command, args, options);
    if (reading && restore) child.once('close', restore);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

const registrationOutcome = ({ report }) =>
  JSON.stringify({
    status: report.result.status,
    projectId: report.projectId,
    revision: report.revision,
    findings: report.result.findings,
  });

async function metadataFixture(t, kind) {
  const f = await fixture(t);
  const root = await f.root();
  const git = fixtureGit(root, f.env);
  const dir = await writeBlueprint(root);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '/.kodo/blueprint/\n');
  const draft = path.join(f.dir, 'draft.json');
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  const manifest = 'crates/codec/Cargo.toml';
  const cargo = name => `[package]\nname="${name}"\nversion="0.1.0"\n`;
  if (kind === 'package.name') {
    spec.tasks.find(task => task.id === 'storage-module').writePaths = [
      'crates/codec/src/lib.rs',
      'crates/*/src/schema.rs',
    ];
    await mkdir(path.join(root, 'crates', 'codec'), { recursive: true });
    await writeFile(path.join(root, manifest), cargo('codec'));
    await writeFile(
      path.join(root, 'rust-toolchain.toml'),
      '[toolchain]\nchannel="1.85.1"\ncomponents=["rustfmt","clippy"]\n',
    );
    git('add', manifest, 'rust-toolchain.toml');
    git('commit', '-qm', 'Existing codec with a pinned toolchain');
  }
  await writeFile(draft, JSON.stringify(spec));
  git('checkout', '-qb', 'strict');
  const file = kind === 'package.name' ? manifest : 'architecture.policy.json';
  const strict =
    kind === 'package.name' ? cargo('api-contracts') : JSON.stringify({ schemaVersion: 2, language: 'rust' });
  await writeFile(path.join(root, file), strict);
  git('add', file);
  git('commit', '-qm', 'Require a different blueprint');
  return { ...f, root, blueprintDir: dir, file, git, draft, args: ['apply-spec', '--root', root, '--file', draft] };
}

// The first race changes the checkout immediately before Git selects the commit.
// A round trip keeps the other checkout active while the compiler reads the draft and
// metadata, and restores the original before preflight. Both trees stay clean.
function moveMetadataBranch(t, f, from, to, roundTrip) {
  const moves = [];
  const checkout = branch => {
    f.git('checkout', '-q', branch);
    moves.push(branch);
  };
  if (roundTrip) {
    const open = fsPromises.open;
    t.mock.method(fsPromises, 'open', (file, ...args) => {
      if (!moves.length && file === path.join(f.blueprintDir, 'PROJECT.md')) checkout(to);
      return open(file, ...args);
    });
  }
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command === 'git') {
      const selectsHead = args.includes('rev-parse') && args.at(-1) === 'HEAD^{commit}';
      const checksConfig = args.includes('ls-tree') && args.at(-1) === 'kodo.config.json';
      if (!roundTrip && !moves.length && selectsHead) checkout(to);
      if (roundTrip && moves.length === 1 && (selectsHead || checksConfig)) checkout(from);
    }
    return spawn(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return moves;
}

function registeredProjects(home) {
  const file = path.join(home, 'state.sqlite');
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT count(*) AS n FROM kodo_project_records WHERE kind='project'").get().n;
  } finally {
    db.close();
  }
}

for (const [kind, finding] of [
  ['policy', 'rust_toolchain_required'],
  ['package.name', 'contract_scope_too_broad'],
]) {
  test(`apply-spec registration metadata uses the selected commit for ${kind}`, async t => {
    const f = await metadataFixture(t, kind);
    for (const [from, to, roundTrip] of [
      ['main'],
      ['strict'],
      ['main', 'strict'],
      ['strict', 'main'],
      ['strict', 'main', true],
      ['main', 'strict', true],
    ]) {
      const route = [from, to, roundTrip && from].filter(Boolean);
      await t.test(route.join(' -> '), async sub => {
        f.git('checkout', '-q', from);
        const moves = to ? moveMetadataBranch(sub, f, from, to, roundTrip) : [];
        const home = path.join(f.home, route.join('-'));
        const { report, exitCode } = await f.run(f.args, { home });
        const selected = route.at(-1);
        assert.deepEqual(moves, route.slice(1));
        assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), selected);
        assert.equal(f.git('status', '--porcelain'), '');
        assert.deepEqual(
          [
            exitCode,
            report.result.status,
            report.result.findings?.map(item => item.code) ?? [],
            registeredProjects(home),
          ],
          selected === 'strict' ? [1, 'invalid', [finding], 0] : [0, 'created', [], 1],
        );
        if (selected === 'strict') assert.equal(existsSync(home), false, 'rejected before evidence or the Store');
      });
    }
  });

  test(`apply-spec registration metadata fails closed on an unreadable ${kind} blob`, async t => {
    const f = await metadataFixture(t, kind);
    f.git('checkout', '-q', 'main');
    if (kind === 'policy') {
      await writeFile(path.join(f.root, f.file), '{"schemaVersion":1}');
      f.git('add', f.file);
      f.git('commit', '-qm', 'Readable non-Rust policy');
    }
    const entries = kind === 'package.name' ? [f.file, 'crates/codec'] : [f.file];
    for (const entry of entries) {
      const oid = f.git('rev-parse', `HEAD:${entry}`);
      const object = path.join(f.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
      const backup = path.join(f.dir, 'saved-object');
      await rename(object, backup);
      try {
        const { report, exitCode } = await f.run(f.args);
        assert.equal(exitCode, 1, registrationOutcome({ report }));
        assert.ok(codes(report).includes('blueprint_cargo_evidence_unavailable'), registrationOutcome({ report }));
        assert.equal(existsSync(f.home), false);
      } finally {
        await rename(backup, object);
      }
    }
  });

  test(`standalone compile reads draft ${kind} and honors explicit options`, async t => {
    const f = await metadataFixture(t, kind);
    const content = await readFile(path.join(f.root, f.file));
    f.git('checkout', '-q', 'main');
    if (kind === 'package.name') {
      f.git('rm', '-q', f.file);
      f.git('commit', '-qm', 'No committed manifest in the planned crate');
      await mkdir(path.dirname(path.join(f.root, f.file)), { recursive: true });
    }
    await writeFile(path.join(f.root, '.git', 'info', 'exclude'), `/.kodo/blueprint/\n/${f.file}\n`);
    await writeFile(path.join(f.root, f.file), content);
    assert.equal(f.git('status', '--porcelain'), '');
    const draft = { specFile: f.draft };
    assert.deepEqual(
      (await compileBlueprint(f.root, draft)).findings.map(item => item.code),
      [finding],
    );
    const override = kind === 'policy' ? { architecturePolicy: null } : { packageNames: {} };
    assert.deepEqual((await compileBlueprint(f.root, { ...draft, ...override })).findings, []);
    const registered = await f.run(f.args);
    assert.equal(registered.report.result.status, 'created', registrationOutcome(registered));
    // A standalone draft may also predate git init. Supply the toolchain explicitly.
    await rename(path.join(f.root, '.git'), path.join(f.dir, 'fixture-git'));
    const options = { ...draft, hasRustToolchain: kind === 'package.name' };
    const plain = await compileBlueprint(f.root, options);
    assert.equal(plain.headSha, null);
    assert.deepEqual(
      plain.findings.map(item => item.code),
      [finding],
    );
  });
}

test('apply-spec registration metadata reads only selected, bounded UTF-8 package manifests', async t => {
  const f = await metadataFixture(t, 'package.name');
  f.git('checkout', '-q', 'main');
  const maxBytes = 64 * 1024;
  const header = Buffer.from('\uFEFF[package]\nname="codec"\n#');
  const atLimit = Buffer.concat([header, Buffer.alloc(maxBytes - header.length, 0x78)]);
  // An unrelated manifest would exceed the package-name read limit.
  const unrelated = 'tools/another/Cargo.toml';
  await mkdir(path.dirname(path.join(f.root, unrelated)), { recursive: true });
  await writeFile(path.join(f.root, unrelated), Buffer.alloc(maxBytes + 1, 0x78));
  f.git('add', unrelated);
  for (const [label, bytes, expected] of [
    ['at-limit', atLimit, []],
    ['over-limit', Buffer.concat([atLimit, Buffer.from('x')]), ['blueprint_cargo_evidence_unavailable']],
    ['invalid-utf8', Buffer.concat([header, Buffer.from([0xff])]), ['blueprint_cargo_evidence_unavailable']],
  ]) {
    await writeFile(path.join(f.root, f.file), bytes);
    f.git('add', f.file);
    f.git('commit', '-qm', label);
    const home = path.join(f.home, label);
    const result = await f.run(f.args, { home });
    assert.deepEqual(
      result.report.result.findings?.map(item => item.code) ?? [],
      expected,
      registrationOutcome(result),
    );
    assert.equal(result.exitCode, expected.length ? 1 : 0);
    assert.equal(existsSync(home), !expected.length);
  }
});

test('apply-spec rejects a clean HEAD switch during the toolchain read before opening state', async t => {
  const f = await registrationFixture(t);
  duringTreeRead(t, 'rust-toolchain.toml', () => f.git('checkout', '-q', 'without-pin'));
  const changed = await f.apply();
  assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'without-pin');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(changed.exitCode, 1, registrationOutcome(changed));
  assert.deepEqual(codes(changed.report), ['blueprint_git_required']);
  assert.equal(changed.report.projectId, null);
  assert.equal(existsSync(f.home), false, 'compilation already observed the old commit');
});

test('apply-spec checks kodo.config.json in the compiled tree even if HEAD returns before registration', async t => {
  const f = await registrationFixture(t);
  f.git('checkout', '-qb', 'missing-config');
  f.git('rm', '-q', '--', 'kodo.config.json');
  f.git('commit', '-qm', 'Remove wave configuration');
  let reads = 0;
  duringTreeRead(
    t,
    'kodo.config.json',
    () => {
      reads++;
      f.git('checkout', '-q', 'main');
    },
    () => f.git('checkout', '-q', 'missing-config'),
  );
  const invalid = await f.apply();
  assert.equal(reads, 1);
  assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'missing-config');
  assert.equal(invalid.exitCode, 1, registrationOutcome(invalid));
  assert.deepEqual(codes(invalid.report), ['blueprint_config_missing']);
  assert.equal(existsSync(f.home), false);
});

test('apply-spec rejects a clean HEAD switch after evidence, then retries and replays the same command id', async t => {
  const f = await registrationFixture(t);
  const { store } = await f.direct();
  const projects = () =>
    store.db.prepare("SELECT count(*) AS n FROM kodo_project_records WHERE kind='project'").get().n;
  const engine = new Engine({ store, secrets: {} });
  const batch = engine.withEvidenceBatch.bind(engine);
  engine.withEvidenceBatch = async (...args) => {
    const bound = await batch(...args);
    assert.ok(bound.ok && bound.interfaces.length);
    f.git('checkout', '-q', 'without-pin');
    return bound;
  };
  const changed = await f.apply({ store, createEngine: () => engine });
  assert.equal(f.git('symbolic-ref', '--short', 'HEAD'), 'without-pin');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(changed.exitCode, 1, registrationOutcome(changed));
  assert.deepEqual(codes(changed.report), ['blueprint_git_required']);
  assert.equal(projects(), 0);
  const missing = await f.apply({ store });
  assert.equal(missing.exitCode, 1, registrationOutcome(missing));
  assert.deepEqual(codes(missing.report), ['rust_toolchain_required']);
  assert.equal(projects(), 0);
  f.git('checkout', '-q', '--detach', 'main');
  const valid = await f.apply({ store });
  assert.equal(valid.exitCode, 0, registrationOutcome(valid));
  assert.equal(valid.report.result.status, 'created');
  assert.equal(valid.report.revision, 1);
  // The command payload is independent of the commit. HEAD can resolve to a
  // valid newer commit via an annotated tag, as allowed by HEAD^{commit}.
  f.git('commit', '--allow-empty', '-qm', 'Advance after registration');
  f.git('tag', '-a', 'release', '-m', 'Annotated release');
  f.git('symbolic-ref', 'HEAD', 'refs/tags/release');
  const replay = await f.apply({ store });
  assert.equal(replay.report.result.status, 'replayed', registrationOutcome(replay));
  assert.equal(replay.report.projectId, valid.report.projectId);
  assert.equal(replay.report.revision, 1);
  assert.equal(projects(), 1);
});

function attemptRefMove(move) {
  try {
    move();
    return 'moved';
  } catch (error) {
    return String(error.stderr);
  }
}

async function checkRegistrationLocks(t, refFormat, linked) {
  const f = await registrationFixture(t, { refFormat, linked });
  const format = f.git('config', '--get', '--default', 'files', 'extensions.refStorage');
  if (refFormat === 'reftable' && format === 'files') return t.skip('Git lacks reftable initialization');
  assert.equal(format, refFormat);
  const { store } = await f.direct();
  const ref = f.git('symbolic-ref', 'HEAD');
  const pinned = f.git('rev-parse', 'HEAD');
  const unpinned = f.git('rev-parse', 'without-pin');
  const attempts = [];
  let headBeforeCommit;
  store.db.function('try_moving_head', () => {
    attempts.push(attemptRefMove(() => f.mainGit('update-ref', ref, unpinned, pinned)));
    attempts.push(attemptRefMove(() => f.git('symbolic-ref', 'HEAD', 'refs/heads/without-pin')));
    headBeforeCommit = f.git('rev-parse', 'HEAD');
    return 1;
  });
  store.db.exec(
    'CREATE TEMP TRIGGER move_head AFTER INSERT ON kodo_project_commands BEGIN SELECT try_moving_head(); END',
  );
  const refs = f.git('show-ref', '--head');
  const log = f.git('reflog', 'show', '--all');
  const index = path.resolve(f.root, f.git('rev-parse', '--git-path', 'index'));
  const indexBefore = await readFile(index);
  // A clean file with stale stat metadata normally makes git status rewrite the index.
  await utimes(path.join(f.root, 'kodo.config.json'), new Date(0), new Date(0));
  const created = await f.apply({ store });
  assert.equal(created.exitCode, 0, registrationOutcome(created));
  assert.equal(created.report.revision, 1);
  assert.equal(registeredProjects(f.home), 1, 'project visible to another SQLite connection after COMMIT');
  assert.equal(headBeforeCommit, pinned, 'HEAD during registration: ' + attempts.join(' / '));
  assert.equal(attempts.length, 2);
  for (const error of attempts) assert.match(error, /lock/i);
  assert.equal(f.git('show-ref', '--head'), refs);
  assert.equal(f.git('reflog', 'show', '--all'), log);
  assert.ok(indexBefore.equals(await readFile(index)), 'registration preserves the index');
  f.git('checkout', '-q', 'without-pin');
  f.mainGit('update-ref', ref, unpinned, pinned);
  assert.equal(f.git('status', '--porcelain'), '');
}

for (const refFormat of ['files', 'reftable']) {
  for (const linked of [false, true]) {
    test(`apply-spec holds HEAD and its branch through SQLite COMMIT (${refFormat}, ${linked ? 'linked' : 'main'})`, t =>
      checkRegistrationLocks(t, refFormat, linked));
  }
}

test('an interrupted registration preserves the linked reftable branch and its reflog', async t => {
  const f = await registrationFixture(t, { refFormat: 'reftable', linked: true });
  if (f.git('config', '--get', '--default', 'files', 'extensions.refStorage') !== 'reftable')
    return t.skip('Git lacks reftable initialization');
  const branch = f.git('symbolic-ref', 'HEAD');
  const head = f.git('rev-parse', 'HEAD');
  const refs = f.git('show-ref', '--head');
  const log = f.git('reflog', 'show', '--all');
  const entry = new URL('../runtime/project-blueprint-head.mjs', import.meta.url).href;
  const interrupt = `
    const [entry, root, head] = process.argv.slice(1);
    const { withVerifiedBlueprintHead } = await import(entry);
    await withVerifiedBlueprintHead(root, head, () => process.exit(73));
  `;
  // Exit with Git prepared, before JS can send abort. Git must abort on EOF.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', interrupt, entry, f.root, head], {
    env: workerEnvironment(),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 73, child.stderr);
  assert.equal(f.git('show-ref', '--head'), refs);
  assert.equal(f.git('reflog', 'show', '--all'), log);
  f.mainGit('-c', 'reftable.lockTimeout=5000', 'update-ref', branch, f.git('rev-parse', 'without-pin'), head);
});

test('apply-spec releases a detached linked HEAD after a Store rollback', async t => {
  const f = await registrationFixture(t, { refFormat: 'reftable', linked: true });
  const branch = f.git('symbolic-ref', 'HEAD');
  f.git('checkout', '-q', '--detach');
  const pinned = f.git('rev-parse', 'HEAD');
  const unpinned = f.git('rev-parse', 'without-pin');
  const moveHead = () => f.git('update-ref', '--no-deref', 'HEAD', unpinned, pinned);
  const log = f.git('reflog', 'show', 'HEAD');
  const { store } = await f.direct();
  let headAttempt;
  store.db.function('try_moving_detached', () => {
    headAttempt = attemptRefMove(moveHead);
    f.mainGit('update-ref', branch, unpinned, pinned);
    return 1;
  });
  store.db.exec(
    `CREATE TEMP TRIGGER reject_create AFTER INSERT ON kodo_project_commands BEGIN
       SELECT try_moving_detached();
       SELECT RAISE(ABORT,'fixture rollback');
     END`,
  );
  const failed = await f.apply({ store });
  assert.equal(failed.exitCode, 2, registrationOutcome(failed));
  assert.equal(failed.report.result.code, 'project_blocked');
  assert.equal(registeredProjects(f.home), 0);
  assert.match(headAttempt, /lock/i);
  assert.equal(f.mainGit('rev-parse', branch), unpinned, 'the detached checkout no longer owns the branch');
  assert.equal(f.git('rev-parse', 'HEAD'), pinned);
  assert.equal(f.git('reflog', 'show', 'HEAD'), log);
  moveHead();
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

test('extend refuses a project that is not an accepted wave project before any bundle or session', async t => {
  const f = await fixture(t);
  const root = await f.root();
  await writeBlueprint(root);
  const created = await f.run(['apply-spec', '--root', root]);
  assert.equal(created.exitCode, 0, JSON.stringify(created.report));
  let sessions = 0;
  const provider = {
    runSession: async () => {
      sessions++;
      throw Error('No session before the status check');
    },
  };
  for (const args of [
    ['extend', created.report.projectId, 'Теги', '--prepare'],
    ['extend', created.report.projectId, 'Теги', '--client', 'codex'],
  ]) {
    const result = await f.run(args, { createEngine: fakeEngine(provider) });
    assert.equal(result.exitCode, 2, JSON.stringify(result.report));
    assert.deepEqual(result.report.result, {
      status: 'blocked',
      code: 'project_blocked',
      reason: 'project_append_blocked',
    });
  }
  assert.equal(sessions, 0);
  assert.equal(existsSync(path.join(f.home, 'bootstrap')), false, 'no context bundle was written');
});

test('the director skill follows the factory contract for a new project and a new milestone', async () => {
  const skill = await readFile(
    fileURLToPath(new URL('../skills/kodo-project-director/SKILL.md', import.meta.url)),
    'utf8',
  );
  const section = (title, next) => skill.slice(skill.indexOf(title), next ? skill.indexOf(next) : undefined);
  const blueprint = section('## 1. Чертёж проекта', '## 2.');
  // A missing root is refused (bootstrap_root_missing): a new project's folder is created first.
  assert.match(blueprint, /bootstrap_root_missing/);
  assert.match(blueprint, /создай/i);
  // Data refusals of the factory carry the Kodo code in result.reason (result.code is project_invalid).
  assert.match(blueprint, /bootstrap_context_unsafe[^\n]*result\.reason/);
  // kodo.config.json (client, commands.test) is created and committed before apply-spec.
  const config = blueprint.indexOf('kodo.config.json');
  // Registration runs the issued apply-spec command from result.commands (with its --command-id).
  const registration = blueprint.search(/команду `apply-spec`|apply-spec --root/);
  assert.ok(registration > 0, 'registration step');
  assert.ok(config >= 0 && config < registration, 'config before registration');
  for (const text of ['commands.test', 'claude-code', 'templates/kodo.config.json', 'blueprint_config_missing'])
    assert.ok(blueprint.includes(text), text);
  assert.match(blueprint, /reviewer[^\n]*гейт/);
  const feature = section('## Новая фича в готовый проект', '## Правила');
  assert.match(feature, /interfaceRefs: \[\]/);
  assert.match(feature, /project_append_blocked/);
});

test('a coordinator that runs only result.commands cannot register a project without a committed kodo.config.json', async t => {
  const f = await fixture(t);
  const bare = path.join(f.dir, 'bare');
  await mkdir(bare);
  const git = (...args) => execFileSync('git', args, { cwd: bare, env: f.env, windowsHide: true });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Owned blueprint CLI');
  git('config', 'user.email', 'blueprint-cli@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  await writeFile(path.join(bare, 'README.md'), '# Заметки\n');
  git('add', '.');
  git('commit', '-m', 'Owned fixture');
  const prepared = await f.run(['bootstrap', 'Сервис заметок', '--root', bare, '--prepare'], {
    cli: `node "${cli}"`,
  });
  assert.equal(prepared.exitCode, 0, JSON.stringify(prepared.report));
  await writeBlueprint(bare);
  const env = { ...f.env };
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [path.dirname(process.execPath), env[pathKey]].filter(Boolean).join(path.delimiter);
  // The consumer executes the machine commands as is, in order, and reads only their JSON.
  const consume = () =>
    prepared.report.result.commands.map(item => {
      const ran = spawnSync(item.command, {
        shell: true,
        cwd: bare,
        env,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      });
      return { status: ran.status, report: JSON.parse(ran.stdout) };
    });
  const [refused] = consume();
  assert.equal(refused.status, 1, JSON.stringify(refused.report));
  assert.equal(refused.report.result.code, 'blueprint_findings');
  assert.deepEqual(
    refused.report.result.findings.map(item => item.code),
    ['blueprint_config_missing'],
  );
  assert.match(refused.report.result.findings[0].message, /templates\/kodo\.config\.json/);
  assert.equal(existsSync(path.join(f.home, 'project-interfaces')), false, 'no evidence and no project');

  // The committed config registers the project; the coordinator's file is kept as written.
  const template = path.join(prepared.report.result.bundle.dir, 'templates', 'kodo.config.json');
  const config = JSON.parse(await readFile(template, 'utf8'));
  assert.deepEqual(config.commands.test, [], 'no manifest: the coordinator sets the command');
  config.client = 'claude-code';
  config.commands.test = [{ command: 'node', args: ['--test'] }];
  const text = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(path.join(bare, 'kodo.config.json'), text);
  git('add', 'kodo.config.json');
  git('commit', '-m', 'Kodo config');
  const [created] = consume();
  assert.equal(created.status, 0, JSON.stringify(created.report));
  assert.equal(created.report.result.status, 'created');
  assert.equal(await readFile(path.join(bare, 'kodo.config.json'), 'utf8'), text);
});

test('extend uses the reopen rule of append-milestone: a paused or unsettled accepted project is refused early', async t => {
  const f = await fixture(t);
  const accepted = await acceptedProject(f);
  assert.equal(contracts.projectReopenable(accepted.snapshot), true);
  const variants = {
    legacy: s => delete s.project.execution,
    running: s => (s.project.status = 'running'),
    paused: s => (s.project.paused = true),
    incomplete: s => (s.completeness.tasks = { ...s.completeness.tasks, complete: false }),
    unsettled: s => (s.currentAttempts = s.currentAttempts.map(row => ({ ...row, status: 'running' }))),
    reopened: s => (s.project.reopened = Array.from({ length: 100 }, () => ({}))),
  };
  assert.ok(accepted.snapshot.currentAttempts.length > 0);
  for (const [name, change] of Object.entries(variants)) {
    const snapshot = structuredClone(accepted.snapshot);
    change(snapshot);
    assert.equal(contracts.projectReopenable(snapshot), false, name);
  }
  await accepted.repo.apply({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: accepted.projectId,
    expectedRevision: accepted.repo.snapshot(accepted.projectId).revision,
    actor: 'owner',
    reason: 'Pause the accepted project',
    action: { op: 'setPaused', paused: true },
  });
  const result = await f.run(['extend', accepted.projectId, 'Теги', '--prepare']);
  assert.equal(result.exitCode, 2, JSON.stringify(result.report));
  assert.equal(result.report.result.reason, 'project_append_blocked');
  assert.equal(existsSync(path.join(f.home, 'bootstrap')), false, 'no context bundle was written');
});

test('append-milestone keeps a bound interface Ref copied from the snapshot and refuses one whose evidence fails', async t => {
  const f = await fixture(t);
  const { store } = await f.direct();
  const engine = new Engine({ store, secrets: {} });
  const text = '# core\n';
  const value = {
    schemaVersion: 1,
    module: 'core',
    source: 'interfaces/core.md',
    sha256: 'e'.repeat(64),
    bytes: 7,
    text,
  };
  const stored = await engine.withEvidenceBatch({ artifacts: path.join(f.home, 'project-interfaces') }, write =>
    write('interface', value, { headSha: null }),
  );
  const bound = { kind: 'interface', runId: null, headSha: null, path: stored.path, sha256: stored.sha256 };
  await engine.assertEvidence(bound);
  const file = path.join(f.dir, 'milestone.json');

  // The Ref of an accepted task, copied unchanged: appended, and the new task keeps it for its brief.
  const valid = await acceptedProject(f, { interfaceRefs: [bound] });
  const [copied] = valid.snapshot.tasks.find(task => task.id === 'a').interfaceRefs;
  await writeFile(
    file,
    JSON.stringify(milestone({ tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['a'], interfaceRefs: [copied] })] })),
  );
  const appended = await f.run(['append-milestone', valid.projectId, '--file', file]);
  assert.equal(appended.exitCode, 0, JSON.stringify(appended.report));
  assert.equal(appended.report.result.status, 'appended');
  assert.deepEqual(valid.repo.snapshot(valid.projectId).tasks.find(task => task.id === 'c').interfaceRefs, [bound]);

  // A Ref of the snapshot whose evidence does not verify is not carried into new work.
  const lost = {
    ...bound,
    path: path.join(path.dirname(bound.path), `interface-${'f'.repeat(64)}.json`),
    sha256: 'f'.repeat(64),
  };
  const broken = await acceptedProject(f, { interfaceRefs: [lost] });
  await writeFile(
    file,
    JSON.stringify(milestone({ tasks: [taskSpec('c', { epicId: 'e2', dependsOn: ['a'], interfaceRefs: [lost] })] })),
  );
  const refused = await f.run(['append-milestone', broken.projectId, '--file', file]);
  assert.equal(refused.exitCode, 1, JSON.stringify(refused.report));
  assert.deepEqual(codes(refused.report), ['milestone_interface_unbound']);
  assert.deepEqual(refused.report.result.findings[0].taskIds, ['c']);
  assert.equal(broken.repo.snapshot(broken.projectId).revision, broken.snapshot.revision);
});

test('apply-spec requires kodo.config.json to be a regular file of HEAD, not a directory', async t => {
  const f = await fixture(t);
  const root = path.join(f.dir, 'config-directory');
  await mkdir(path.join(root, 'kodo.config.json'), { recursive: true });
  await writeFile(path.join(root, 'kodo.config.json', 'settings.json'), '{}');
  const git = (...args) => execFileSync('git', args, { cwd: root, env: f.env, windowsHide: true });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Owned blueprint CLI');
  git('config', 'user.email', 'blueprint-cli@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('add', '.');
  git('commit', '-m', 'A directory named like the config');
  await writeBlueprint(root);
  const result = await f.run(['apply-spec', '--root', root]);
  assert.equal(result.exitCode, 1, JSON.stringify(result.report));
  assert.deepEqual(codes(result.report), ['blueprint_config_missing']);
});

test('apply-spec requires the committed config blob to be available before opening the Store', async t => {
  const f = await fixture(t);
  const root = await f.root();
  await writeBlueprint(root);
  const oid = fixtureGit(root, f.env)('rev-parse', 'HEAD:kodo.config.json');
  const blob = path.join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  const saved = path.join(f.dir, 'saved-config-blob');
  const apply = () =>
    spawnSync(process.execPath, [cli, 'project', 'apply-spec', '--root', root, '--json'], {
      cwd: root,
      env: f.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
  await rename(blob, saved);
  try {
    const refused = apply();
    assert.equal(refused.status, 1, refused.stdout);
    assert.deepEqual(codes(JSON.parse(refused.stdout)), ['blueprint_config_missing']);
    assert.equal(existsSync(f.home), false);
  } finally {
    await rename(saved, blob);
  }
  const restored = apply();
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).result.status, 'created');
});

test('apply-spec and append-milestone support 400 tasks and bounded planning time', async t => {
  const f = await fixture(t);
  const root = await f.root();
  const dir = await writeBlueprint(root);
  const file = path.join(dir, 'spec.json');
  const spec = JSON.parse(await readFile(file, 'utf8'));
  const chunk = index => {
    const milestone = { ...spec.milestones[1], id: 'batch-' + index };
    const epic = { ...spec.epics[1], id: 'group-' + index, milestoneId: milestone.id };
    const tasks = Array.from({ length: 80 }, (_, i) => ({
      ...spec.tasks[2],
      id: 'unit-' + index + '-' + i,
      epicId: epic.id,
      writePaths: Array.from({ length: 12 }, (_, j) => 'docs/shared/unit-' + index + '-' + i + '/file-' + j),
      interfaceRefs: [],
      dependsOn: [],
    }));
    return { milestone, epics: [epic], tasks };
  };
  for (let index = 0; spec.tasks.length < 320; index++) {
    const batch = chunk(index);
    spec.milestones.push(batch.milestone);
    spec.epics.push(...batch.epics);
    spec.tasks.push(
      ...batch.tasks.slice(0, 320 - spec.tasks.length).map(task => ({ ...task, dependsOn: ['test-bench'] })),
    );
  }
  for (const task of spec.tasks) {
    while (task.writePaths.length < 12)
      task.writePaths.push('docs/shared/' + task.id + '/file-' + task.writePaths.length);
  }
  const last = chunk(5);
  const milestoneFile = path.join(f.dir, 'milestone.json');
  await writeFile(milestoneFile, JSON.stringify(last));
  const priorRoot = await f.root();
  const priorDir = await writeBlueprint(priorRoot);
  await writeFile(path.join(priorDir, 'spec.json'), JSON.stringify({ ...spec, root: priorRoot }));
  const prior = await f.run(['apply-spec', '--root', priorRoot]);
  assert.equal(prior.exitCode, 0, JSON.stringify(prior.report.result));
  const { repo, store } = await f.direct();
  const priorId = prior.report.projectId;
  assert.equal(repo.snapshot(priorId).tasks.length, 320);
  const { lintMilestone } = await import('../runtime/project-bootstrap.mjs');
  const openHistory = repo.snapshot(priorId);
  const lintStart = performance.now();
  assert.deepEqual(lintMilestone(last, openHistory).findings, []);
  assert.ok(performance.now() - lintStart < 10000, '80 fresh tasks against 320 open tasks within 10 seconds');
  // Stage the closed historical rows for this size benchmark. The separate lifecycle test
  // reaches acceptance through real transitions, while this test exercises the append itself.
  store.db
    .prepare("UPDATE kodo_project_records SET body=json_set(body, '$.status', 'accepted') WHERE project_id=?")
    .run(priorId);
  const appendStart = performance.now();
  const appended = await f.run(['append-milestone', priorId, '--file', milestoneFile]);
  assert.equal(appended.exitCode, 0, JSON.stringify(appended.report.result));
  assert.equal(appended.report.result.tasks.length, 80);
  assert.ok(performance.now() - appendStart < 10000, '80-task append within 10 seconds');
  assert.equal(repo.snapshot(priorId).tasks.length, 400);
  spec.milestones.push(last.milestone);
  spec.epics.push(...last.epics);
  spec.tasks.push(...last.tasks.map(task => ({ ...task, dependsOn: ['test-bench'] })));
  await writeFile(file, JSON.stringify(spec));
  const applied = await f.run(['apply-spec', '--root', root]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.report.result));
  const snapshot = (await f.direct()).repo.snapshot(applied.report.projectId);
  assert.equal(snapshot.tasks.length, 400);
  const { compileBlueprint } = await import('../runtime/project-blueprint.mjs');
  const { selectWave } = await import('../runtime/project-director-waves.mjs');
  const start = performance.now();
  const compiled = await compileBlueprint(root);
  assert.deepEqual(compiled.findings, []);
  assert.ok(selectWave(snapshot, { limit: 5 }).length > 0);
  assert.ok(performance.now() - start < 10000, 'compileBlueprint and selectWave within 10 seconds');
});
