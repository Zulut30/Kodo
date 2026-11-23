import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileBlueprint } from '../runtime/project-blueprint.mjs';
import { normalizeConfig } from '../runtime/config.mjs';
import { assertDirectorSafe } from '../runtime/project-contracts.mjs';
import {
  generateBlueprint,
  generateMilestone,
  lintMilestone,
  prepareBootstrap,
  prepareExtend,
  readMilestoneFile,
} from '../runtime/project-bootstrap.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blueprint');
const PID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-17T00:00:00.000Z';
const codes = result => result.findings.map(item => item.code);

async function temp(t, prefix = 'kodo-bootstrap-') {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tree(dir, prefix = '') {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
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

async function writeValidBlueprint(root, mutate) {
  const dir = path.join(root, '.kodo', 'blueprint');
  await cp(path.join(fixtures, 'valid'), dir, { recursive: true });
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  spec.root = root;
  mutate?.(spec);
  await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
}

function fakeProvider(write) {
  const calls = [];
  return {
    calls,
    async runSession(request) {
      calls.push(request);
      await write?.(request);
      return {
        sessionId: 'fake-session',
        output: { status: 'written', summary: 'Чертёж записан' },
        usage: {},
        model: request.model,
        metrics: {},
      };
    },
  };
}

/** A ProjectSpec turned into a normalized-shape snapshot with chosen statuses. */
function snapshotFrom(spec, statuses = {}) {
  const meta = status => ({
    schemaVersion: 1,
    projectId: PID,
    revision: 1,
    status,
    createdAt: AT,
    updatedAt: AT,
    evidence: [],
    mappings: [],
  });
  const { execution: _execution, milestones, epics, tasks, schemaVersion: _version, ...header } = spec;
  const count = list => ({ total: list.length, returned: list.length, complete: true });
  const snapshot = {
    schemaVersion: 1,
    project: {
      schemaVersion: 1,
      projectId: PID,
      ...header,
      projectKey: 'notes-key',
      status: 'running',
      paused: false,
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
      evidence: [],
      mappings: [],
    },
    revision: 1,
    milestones: milestones.map(item => ({ ...item, ...meta('running') })),
    epics: epics.map(item => ({ ...item, ...meta('running') })),
    tasks: tasks.map(item => ({ ...item, ...meta(statuses[item.id] ?? 'ready') })),
    currentAttempts: [],
    riskApprovals: [],
    completeness: {},
  };
  for (const key of ['milestones', 'epics', 'tasks', 'currentAttempts', 'riskApprovals'])
    snapshot.completeness[key] = count(snapshot[key]);
  return snapshot;
}

async function project(t, statuses) {
  const root = await temp(t);
  await writeValidBlueprint(root);
  const compiled = await compileBlueprint(root);
  assert.equal(compiled.ok, true);
  return { root, spec: compiled.spec, snapshot: snapshotFrom(compiled.spec, statuses) };
}

const criterion = id => ({ id, text: 'Проверяемый результат', evidenceKinds: ['checks'] });
function milestoneFile(overrides = {}) {
  const base = {
    id: 'search-index',
    epicId: 'search-epic',
    title: 'Индекс поиска',
    description: 'Добавить индекс полнотекстового поиска поверх storage.',
    owner: 'developer',
    dependsOn: ['storage-module'],
    writePaths: ['src/search'],
    acceptance: [criterion('index-done')],
    interfaceRefs: [],
    priority: 60,
    userValue: 4,
    risk: 1,
    estimatedEffort: 2,
    riskApprovalRequired: false,
  };
  return {
    milestone: { id: 'search', title: 'Поиск', acceptance: [criterion('search-done')], releaseRequired: false },
    epics: [{ id: 'search-epic', milestoneId: 'search', title: 'Поиск', acceptance: [criterion('epic-done')] }],
    tasks: [
      { ...base, ...overrides.index },
      {
        ...base,
        id: 'search-review',
        owner: 'reviewer',
        dependsOn: ['search-index'],
        writePaths: ['docs/search-review.md'],
        ...overrides.review,
      },
    ],
  };
}

test('prepareBootstrap writes the bundle only under home and leaves the repository unchanged', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { react: '1' } }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.mjs'), 'export {};\n');
  await mkdir(path.join(root, 'node_modules', 'react'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'react', 'index.js'), '');
  const before = await tree(root);
  const result = await prepareBootstrap({ prompt: 'Сервис заметок с поиском', root, home, now: AT });
  assert.deepEqual(await tree(root), before);
  assert.equal(path.dirname(result.dir), path.join(home, 'bootstrap'));
  assert.match(result.id, /^bootstrap-20261117T000000000Z-[a-f0-9]{8}$/);
  assert.deepEqual(result.files, [
    'context.md',
    'rules.md',
    'templates/PROJECT.md',
    'templates/interfaces/module.md',
    'templates/spec.json',
    'templates/kodo.config.json',
  ]);
  assert.deepEqual(
    (await tree(result.dir)).filter(item => item.length === 2).map(([name]) => name),
    [...result.files].sort(),
  );
  const context = await readFile(path.join(result.dir, 'context.md'), 'utf8');
  assert.match(context, /Сервис заметок с поиском/);
  assert.match(context, /Node\.js \/ npm: package\.json/);
  assert.match(context, /известные зависимости: react/);
  assert.match(context, /src\/index\.mjs/);
  assert.doesNotMatch(context, /node_modules\/react/);
  const rules = await readFile(path.join(result.dir, 'rules.md'), 'utf8');
  for (const text of ['12000', 'foundation', 'architect', 'ui-qa', 'performance', 'blueprint_parallel_overlap'])
    assert.ok(rules.includes(text), text);
  const template = JSON.parse(await readFile(path.join(result.dir, 'templates', 'spec.json'), 'utf8'));
  assert.equal(template.root, root);
  assert.deepEqual(template.execution, { cadence: 'wave', integration: 'branch' });
  assert.deepEqual(result.summary, {
    kind: 'bootstrap',
    root,
    empty: false,
    stack: ['Node.js / npm'],
    listedFiles: 2,
    completeFileMap: true,
    architecture: false,
    knowledge: false,
    redacted: false,
  });
});

test('prepareBootstrap skips installed agent skill directories and keeps a complete file map', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'index.mjs'), 'export {};\n');
  // Kodo init installs skills for every client: far more files than the listed limit.
  for (const client of ['.agents', '.claude', '.codex', '.opencode'])
    for (let skill = 0; skill < 120; skill++) {
      const dir = path.join(root, client, 'skills', `skill-${skill}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), '# skill\n');
    }
  const result = await prepareBootstrap({ prompt: 'Сервис заметок', root, home, now: AT });
  assert.equal(result.summary.completeFileMap, true);
  assert.equal(result.summary.listedFiles, 1);
  const context = await readFile(path.join(result.dir, 'context.md'), 'utf8');
  assert.match(context, /src\/index\.mjs/);
  assert.doesNotMatch(context, /SKILL\.md/);
  assert.match(context, /клиентов агентов \(\.agents, \.claude, \.codex, \.opencode\)/, 'the caption names them');

  // The session scope check still watches these folders: client settings and hooks are not the blueprint.
  for (const client of ['.agents', '.claude', '.codex', '.opencode']) {
    const session = fakeProvider(async request => {
      await writeValidBlueprint(request.cwd);
      await writeFile(path.join(request.cwd, client, 'settings.json'), '{"hooks":{}}');
    });
    const generated = await generateBlueprint({ provider: session, client: 'codex', root, home, prompt: 'x' });
    assert.equal(generated.scopeChecked, true, client);
    assert.deepEqual(codes(generated), ['blueprint_session_scope'], client);
    assert.match(generated.findings[0].message, new RegExp(`${client.replace('.', '\\.')}/settings\\.json`));
    await rm(path.join(root, client, 'settings.json'));
  }
});

test('bundle templates compile into a passing blueprint', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  const bundle = await prepareBootstrap({ prompt: 'Пустой проект', root, home });
  const dir = path.join(root, '.kodo', 'blueprint');
  await mkdir(path.join(dir, 'interfaces'), { recursive: true });
  for (const [from, to] of [
    ['templates/PROJECT.md', 'PROJECT.md'],
    ['templates/spec.json', 'spec.json'],
    ['templates/interfaces/module.md', 'interfaces/core.md'],
  ])
    await cp(path.join(bundle.dir, from), path.join(dir, to));
  const result = await compileBlueprint(root);
  assert.deepEqual(result.findings, []);
});

test('an empty project folder is accepted; a missing root or a home inside root is not', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  const result = await prepareBootstrap({ prompt: 'Игра в слова', root, home });
  assert.equal(result.summary.empty, true);
  assert.deepEqual(result.summary.stack, []);
  assert.match(await readFile(path.join(result.dir, 'context.md'), 'utf8'), /Каталог пуст\./);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(prepareBootstrap({ prompt: 'x', root: path.join(root, 'absent'), home }), {
    code: 'bootstrap_root_missing',
  });
  await assert.rejects(prepareBootstrap({ prompt: 'x', root, home: path.join(root, 'state') }), {
    code: 'bootstrap_home_inside_root',
  });
  await assert.rejects(prepareBootstrap({ prompt: '  ', root, home }), { code: 'bootstrap_prompt_invalid' });
  await assert.rejects(prepareBootstrap({ prompt: 'x', root, home: 'relative' }), { code: 'bootstrap_home_invalid' });
  assert.deepEqual(await readdir(root), []);
});

test('architecture graph and knowledge are rendered when supplied', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  const architecture = async () => ({
    schemaVersion: 1,
    modules: [
      { id: 'api', roots: ['src/api'], public: ['src/api/index.mjs'] },
      { id: 'storage', roots: ['src/storage'], public: [] },
    ],
    edges: [{ from: 'src/api/routes.mjs', to: 'src/storage/index.mjs' }],
  });
  const result = await prepareBootstrap({
    prompt: 'x',
    root,
    home,
    architecture,
    knowledge: { schemaVersion: 1, rows: [], unknowns: [] },
  });
  const context = await readFile(path.join(result.dir, 'context.md'), 'utf8');
  assert.match(context, /- api: src\/api; public: src\/api\/index\.mjs/);
  assert.match(context, /- api → storage: 1/);
  assert.match(context, /"references": \[\]/);
  assert.equal(result.summary.architecture, true);
  assert.equal(result.summary.knowledge, true);
});

test('generateBlueprint runs one native session in root and compiles what it wrote', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  const provider = fakeProvider(request => writeValidBlueprint(request.cwd));
  const result = await generateBlueprint({
    provider,
    client: 'claude-code',
    model: 'opus',
    root,
    home,
    prompt: 'Сервис заметок',
  });
  assert.equal(provider.calls.length, 1);
  const [call] = provider.calls;
  assert.equal(call.client, 'claude-code');
  assert.equal(call.model, 'opus');
  assert.equal(call.cwd, root);
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.schema.required, ['status', 'summary']);
  assert.match(call.prompt, /=== rules\.md ===/);
  assert.match(call.prompt, /Сервис заметок/);
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.spec.tasks.length, 7);
  assert.equal(result.interfaces.length, 3);
  assert.deepEqual(result.session, {
    sessionId: 'fake-session',
    model: 'opus',
    status: 'written',
    summary: 'Чертёж записан',
  });
  assert.equal(result.scopeChecked, true);
  assert.equal(path.dirname(result.dir), path.join(home, 'bootstrap'));
});

test('generateBlueprint reports writes outside the blueprint, invalid blueprints and propagates failures', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  const outside = fakeProvider(async request => {
    await writeValidBlueprint(request.cwd, spec => {
      spec.tasks.find(item => item.id === 'web-module').dependsOn = [];
    });
    await writeFile(path.join(request.cwd, 'README.md'), 'изменено');
  });
  const result = await generateBlueprint({ provider: outside, client: 'codex', root, home, prompt: 'x' });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['blueprint_session_scope', 'blueprint_wave0_bypassed']);
  assert.match(result.findings[0].message, /README\.md/);

  const failing = {
    calls: 0,
    async runSession() {
      this.calls++;
      throw Object.assign(new Error('limit'), { code: 'quota' });
    },
  };
  await assert.rejects(generateBlueprint({ provider: failing, client: 'codex', root, home, prompt: 'x' }), {
    code: 'quota',
  });
  assert.equal(failing.calls, 1, 'no retry or API fallback');

  const unused = fakeProvider();
  await assert.rejects(generateBlueprint({ provider: unused, client: 'openai-api', root, home, prompt: 'x' }), {
    code: 'bootstrap_client_invalid',
  });
  await assert.rejects(generateBlueprint({ client: 'codex', root, home, prompt: 'x' }), {
    code: 'bootstrap_provider_invalid',
  });
  assert.equal(unused.calls.length, 0);

  const blocked = {
    async runSession() {
      return { sessionId: 's', output: { status: 'blocked', summary: 'Неясно' } };
    },
  };
  const empty = await temp(t);
  const blockedResult = await generateBlueprint({ provider: blocked, client: 'codex', root: empty, home, prompt: 'x' });
  assert.deepEqual(codes(blockedResult), ['blueprint_session_blocked', 'blueprint_missing']);
});

test('prepareExtend builds a module map from the snapshot without rescanning code', async t => {
  const { root, snapshot } = await project(t, {
    scaffold: 'accepted',
    'test-bench': 'accepted',
    'web-module': 'running',
  });
  const home = await temp(t, 'kodo-home-');
  await mkdir(path.join(root, 'src', 'unlisted'), { recursive: true });
  await writeFile(path.join(root, 'src', 'unlisted', 'marker-file.mjs'), '');
  const before = await tree(root);
  const result = await prepareExtend({ snapshot, prompt: 'Добавить теги к заметкам', root, home, now: AT });
  assert.deepEqual(await tree(root), before);
  assert.match(result.id, /^extend-/);
  assert.deepEqual(result.files, ['context.md', 'rules.md', 'templates/milestone.json']);
  const context = await readFile(path.join(result.dir, 'context.md'), 'utf8');
  assert.doesNotMatch(context, /marker-file/);
  assert.match(context, /### foundation — Волна 0: каркас \[running\]/);
  assert.match(context, /- эпик storage — Хранение заметок/);
  assert.match(
    context,
    /- api-module \[ready\] owner=developer; deps: test-bench; writePaths: src\/api; interfaces: api\.md, storage\.md/,
  );
  assert.match(context, /- web-module \[running\]/);
  assert.match(context, /## Принятые задачи[^\n]*\n\nscaffold, test-bench\n/);
  const template = JSON.parse(await readFile(path.join(result.dir, 'templates', 'milestone.json'), 'utf8'));
  assert.deepEqual(template.tasks[0].dependsOn, ['scaffold']);
  assert.deepEqual(lintMilestone(template, snapshot), { ok: true, findings: [] });
  assert.deepEqual(result.summary, {
    kind: 'extend',
    root,
    projectId: PID,
    revision: 1,
    milestones: 2,
    tasks: 7,
    acceptedTasks: 2,
    architecture: false,
    knowledge: false,
    redacted: false,
  });
  const other = await temp(t);
  await assert.rejects(prepareExtend({ snapshot, prompt: 'x', root: other, home }), {
    code: 'bootstrap_root_mismatch',
  });
  await assert.rejects(prepareExtend({ snapshot: { ...snapshot, revision: 2 }, prompt: 'x', root, home }), {
    code: 'bootstrap_snapshot_invalid',
  });
});

test('generateMilestone runs one read-only session and writes its milestone outside the repository', async t => {
  const { root, snapshot } = await project(t, { 'storage-module': 'accepted' });
  const home = await temp(t, 'kodo-home-');
  const before = await tree(root);
  const proposed = {
    calls: [],
    async runSession(request) {
      this.calls.push(request);
      return {
        sessionId: 'fake-extend',
        model: 'fake-model',
        output: { status: 'proposed', summary: 'Майлстоун поиска', milestone: JSON.stringify(milestoneFile()) },
      };
    },
  };
  const result = await generateMilestone({
    provider: proposed,
    client: 'claude-code',
    snapshot,
    prompt: 'Добавить поиск',
    root,
    home,
    now: AT,
  });
  assert.equal(proposed.calls.length, 1);
  const [request] = proposed.calls;
  assert.equal(request.client, 'claude-code');
  assert.equal(request.readOnly, true);
  assert.equal(request.cwd, root);
  assert.match(request.prompt, /=== templates\/milestone\.json ===/);
  assert.deepEqual(request.schema.required, ['status', 'summary', 'milestone']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.file, path.join(result.dir, 'milestone.json'));
  assert.deepEqual(await readMilestoneFile(result.file), milestoneFile());
  assert.deepEqual(result.session, {
    sessionId: 'fake-extend',
    model: 'fake-model',
    status: 'proposed',
    summary: 'Майлстоун поиска',
  });
  assert.deepEqual(await tree(root), before, 'the repository is unchanged');

  const blocked = {
    async runSession() {
      return { output: { status: 'blocked', summary: 'Неясно', milestone: '' } };
    },
  };
  const blockedResult = await generateMilestone({
    provider: blocked,
    client: 'codex',
    snapshot,
    prompt: 'x',
    root,
    home,
  });
  assert.deepEqual(codes(blockedResult), ['milestone_session_blocked']);
  assert.equal(blockedResult.file, null);
  const garbage = { runSession: async () => ({ output: 'не JSON' }) };
  assert.deepEqual(
    codes(await generateMilestone({ provider: garbage, client: 'codex', snapshot, prompt: 'x', root, home })),
    ['milestone_session_output'],
  );
  const failing = {
    runSession: async () => {
      throw Object.assign(new Error('subscription unavailable'), { code: 'unavailable' });
    },
  };
  await assert.rejects(generateMilestone({ provider: failing, client: 'codex', snapshot, prompt: 'x', root, home }), {
    code: 'unavailable',
  });
  await assert.rejects(generateMilestone({ provider: failing, client: 'api', snapshot, prompt: 'x', root, home }), {
    code: 'bootstrap_client_invalid',
  });
});

test('lintMilestone accepts new records depending on accepted tasks', async t => {
  const { snapshot } = await project(t, { 'storage-module': 'accepted' });
  assert.deepEqual(lintMilestone(milestoneFile(), snapshot), { ok: true, findings: [] });
});

test('lintMilestone catches foreign parents and dependencies on unfinished tasks', async t => {
  const { snapshot } = await project(t, { 'storage-module': 'accepted', 'web-module': 'running' });
  const foreign = milestoneFile();
  foreign.epics[0].milestoneId = 'mvp';
  foreign.tasks[1].epicId = 'api';
  const foreignResult = lintMilestone(foreign, snapshot);
  assert.deepEqual(codes(foreignResult), ['milestone_foreign_parent']);
  assert.deepEqual(foreignResult.findings[0].taskIds, ['search-epic', 'search-review']);

  const open = lintMilestone(milestoneFile({ index: { dependsOn: ['web-module'] } }), snapshot);
  assert.deepEqual(codes(open), ['milestone_dependency_not_accepted']);
  assert.deepEqual(open.findings[0].taskIds, ['search-index']);

  const unknown = lintMilestone(milestoneFile({ index: { dependsOn: ['ghost'] } }), snapshot);
  assert.deepEqual(codes(unknown), ['milestone_dependency_unknown']);
});

test('lintMilestone enforces new ids, size, parallel paths, task input and snapshot completeness', async t => {
  const { snapshot } = await project(t, { 'storage-module': 'accepted', 'web-module': 'running' });
  const conflict = lintMilestone(milestoneFile({ review: { id: 'api-module' } }), snapshot);
  assert.deepEqual(codes(conflict), ['milestone_id_conflict']);
  assert.deepEqual(conflict.findings[0].taskIds, ['api-module']);

  const many = milestoneFile();
  for (let index = 0; index < 5; index++)
    many.tasks.push({ ...many.tasks[1], id: `extra-${index}`, writePaths: [`docs/extra-${index}.md`] });
  assert.deepEqual(codes(lintMilestone(many, snapshot)), ['milestone_task_count']);

  const overlap = lintMilestone(milestoneFile({ index: { writePaths: ['src/web/search'] } }), snapshot);
  assert.deepEqual(codes(overlap), ['blueprint_parallel_overlap']);
  assert.deepEqual(overlap.findings[0].taskIds, ['search-index', 'web-module']);

  const sibling = lintMilestone(
    milestoneFile({ review: { dependsOn: ['storage-module'], writePaths: ['src/search/review.md'] } }),
    snapshot,
  );
  assert.deepEqual(codes(sibling), ['blueprint_parallel_overlap']);
  assert.deepEqual(sibling.findings[0].taskIds, ['search-index', 'search-review']);

  const large = lintMilestone(milestoneFile({ index: { description: 'Очень подробно. '.repeat(800) } }), snapshot);
  assert.deepEqual(codes(large), ['split_required']);
  assert.deepEqual(large.findings[0].taskIds, ['search-index']);

  assert.deepEqual(codes(lintMilestone({ milestone: {}, tasks: [] }, snapshot)), ['milestone_shape']);
  assert.deepEqual(codes(lintMilestone(milestoneFile({ index: { extra: 1 } }), snapshot)), ['milestone_spec_invalid']);
  const partial = structuredClone(snapshot);
  partial.completeness.tasks = { total: 8, returned: 7, complete: false };
  assert.deepEqual(codes(lintMilestone(milestoneFile(), partial)), ['milestone_snapshot_incomplete']);
});

test('readMilestoneFile reads bounded regular JSON files only', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'milestone.json');
  await writeFile(file, JSON.stringify(milestoneFile()));
  assert.deepEqual(await readMilestoneFile(file), milestoneFile());
  await assert.rejects(readMilestoneFile(path.join(dir, 'absent.json')), { code: 'milestone_missing' });
  await writeFile(path.join(dir, 'broken.json'), '{');
  await assert.rejects(readMilestoneFile(path.join(dir, 'broken.json')), { code: 'milestone_invalid_json' });
  await writeFile(path.join(dir, 'large.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(readMilestoneFile(path.join(dir, 'large.json')), { code: 'milestone_too_large' });
});

test('readMilestoneFile rejects a symlinked milestone file', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'milestone.json');
  await writeFile(file, JSON.stringify(milestoneFile()));
  try {
    await symlink(file, path.join(dir, 'link.json'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('host does not allow file symlinks');
    throw error;
  }
  await assert.rejects(readMilestoneFile(path.join(dir, 'link.json')), { code: 'milestone_unsafe_path' });
});

// Review finding: repository metadata (file names, package.json, architecture
// graph) carrying a known secret reached context.md and the native prompt.
const KNOWN_SECRET = 'kodo-known-secret-7f3a9c1e5b';
const PEM_KEY = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
const SHAPED = 'sk-proj-abcdefghijklmnopqrstuv';
const leakyGraph = {
  modules: [{ id: 'core', roots: [`src/${KNOWN_SECRET}`], public: [SHAPED] }],
  edges: [],
};
function assertClean(text) {
  assert.ok(!text.includes(KNOWN_SECRET), 'known secret is redacted');
  assert.ok(!text.includes(SHAPED), 'credential-shaped value is redacted');
  assert.doesNotMatch(text, /BEGIN PRIVATE KEY/);
  assertDirectorSafe(text, { knownValues: [KNOWN_SECRET] });
}

test('bootstrap context and the native prompt redact known secrets, PEM keys and credential-shaped values', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  await writeFile(path.join(root, `notes-${KNOWN_SECRET}.md`), '');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: PEM_KEY }));
  const options = { prompt: 'Сервис заметок', root, home, now: AT, architecture: leakyGraph };
  const prepared = await prepareBootstrap({ ...options, knownValues: [KNOWN_SECRET] });
  const context = await readFile(path.join(prepared.dir, 'context.md'), 'utf8');
  assertClean(context);
  assert.match(context, /notes-\[REDACTED\]\.md/);
  assert.match(context, /src\/\[REDACTED\]/);
  assert.equal(prepared.summary.redacted, true);
  for (const name of prepared.files) assertClean(await readFile(path.join(prepared.dir, name), 'utf8'));

  const provider = fakeProvider(request => writeValidBlueprint(request.cwd));
  const generated = await generateBlueprint({ ...options, provider, client: 'codex', knownValues: [KNOWN_SECRET] });
  assert.equal(provider.calls.length, 1);
  assertClean(provider.calls[0].prompt);
  assert.match(provider.calls[0].prompt, /notes-\[REDACTED\]\.md/);
  assert.equal(generated.ok, true, JSON.stringify(generated.findings));
});

test('extend context and the milestone prompt redact known secrets', async t => {
  const { root, snapshot } = await project(t, { 'storage-module': 'accepted' });
  const home = await temp(t, 'kodo-home-');
  const options = { snapshot, prompt: 'Добавить поиск', root, home, now: AT, architecture: leakyGraph };
  const prepared = await prepareExtend({ ...options, knownValues: [KNOWN_SECRET] });
  for (const name of prepared.files) assertClean(await readFile(path.join(prepared.dir, name), 'utf8'));
  assert.equal(prepared.summary.redacted, true);
  const calls = [];
  const provider = {
    async runSession(request) {
      calls.push(request);
      return { output: { status: 'proposed', summary: 'Поиск', milestone: JSON.stringify(milestoneFile()) } };
    },
  };
  const generated = await generateMilestone({ ...options, provider, client: 'codex', knownValues: [KNOWN_SECRET] });
  assert.equal(generated.ok, true);
  assert.equal(calls.length, 1);
  assertClean(calls[0].prompt);
});

test('context that cannot be redacted safely is refused before anything is written', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: PEM_KEY }));
  // The redaction marker itself contains this known value: Kodo fails closed.
  await assert.rejects(prepareBootstrap({ prompt: 'x', root, home, knownValues: ['REDACTED'] }), {
    code: 'bootstrap_context_unsafe',
  });
  assert.deepEqual(await readdir(home), []);
  const provider = fakeProvider();
  await assert.rejects(
    generateBlueprint({ provider, client: 'codex', root, home, prompt: 'x', knownValues: ['REDACTED'] }),
    { code: 'bootstrap_context_unsafe' },
  );
  assert.equal(provider.calls.length, 0, 'the provider never receives unsafe context');
});

test('lintMilestone reports a new epic without a task before append', async t => {
  // Review finding (major): appendMilestone admitted an empty epic, which never got a gate.
  const { snapshot } = await project(t, { 'storage-module': 'accepted' });
  const idle = milestoneFile();
  idle.epics.push({ id: 'idle-epic', milestoneId: 'search', title: 'Пусто', acceptance: [criterion('idle-done')] });
  const result = lintMilestone(idle, snapshot);
  assert.deepEqual(codes(result), ['blueprint_container_empty']);
  assert.match(result.findings[0].message, /эпик idle-epic/);
  assert.deepEqual(codes(lintMilestone(milestoneFile(), snapshot)), []);
});

test('lintMilestone reports epic cycles of the new milestone before append', async t => {
  const { snapshot } = await project(t, { 'storage-module': 'accepted' });
  const cyclic = milestoneFile({ review: { dependsOn: ['tags-index'] } });
  cyclic.epics.push({ id: 'tags-epic', milestoneId: 'search', title: 'Теги', acceptance: [criterion('tags-done')] });
  cyclic.tasks.push({
    ...cyclic.tasks[0],
    id: 'tags-index',
    epicId: 'tags-epic',
    dependsOn: ['search-index'],
    writePaths: ['src/tags'],
  });
  const result = lintMilestone(cyclic, snapshot);
  assert.deepEqual(codes(result), ['blueprint_epic_cycle']);
  assert.deepEqual(result.findings[0].taskIds, ['search-review', 'tags-index']);
  assert.match(result.findings[0].message, /search-epic, tags-epic/);
  const chain = structuredClone(cyclic);
  chain.tasks[1].dependsOn = ['search-index'];
  assert.deepEqual(lintMilestone(chain, snapshot), { ok: true, findings: [] });
});

test('prepareBootstrap writes a kodo.config.json template whose test command follows the stack', async t => {
  const home = await temp(t, 'kodo-home-');
  const cases = [
    [{}, [{ command: 'npm', args: ['test'] }]],
    [{ 'package.json': '{}' }, [{ command: 'npm', args: ['test'] }]],
    [{ 'pyproject.toml': '[project]\n' }, [{ command: 'python', args: ['-m', 'pytest'] }]],
    [{ 'Cargo.toml': '[package]\n' }, [{ command: 'cargo', args: ['test'] }]],
    [{ 'go.mod': 'module x\n' }, [{ command: 'go', args: ['test', './...'] }]],
    // A stack without a known test command gets none: the coordinator must set it explicitly.
    [{ 'composer.json': '{}' }, []],
  ];
  for (const [files, test] of cases) {
    const root = await temp(t);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
    const result = await prepareBootstrap({ prompt: 'Сервис заметок', root, home });
    assert.ok(result.files.includes('templates/kodo.config.json'), JSON.stringify(files));
    const config = JSON.parse(await readFile(path.join(result.dir, 'templates', 'kodo.config.json'), 'utf8'));
    assert.equal(config.client, 'codex');
    assert.deepEqual(config.commands.test, test, JSON.stringify(files));
    assert.deepEqual(normalizeConfig(config).commands.test, test, 'the template is a valid kodo.config.json');
  }
  const rules = await readFile(
    path.join((await prepareBootstrap({ prompt: 'x', root: await temp(t), home })).dir, 'rules.md'),
    'utf8',
  );
  for (const text of [
    'kodo.config.json',
    'commands.test',
    'client',
    'claude-code',
    'apply-spec',
    'fast_check_no_tests',
  ])
    assert.ok(rules.includes(text), text);
});

test('bundle templates add no trailing reviewer task and give Wave 0 a minimal test', async t => {
  const root = await temp(t),
    home = await temp(t, 'kodo-home-');
  const bundle = await prepareBootstrap({ prompt: 'Сервис заметок', root, home });
  const spec = JSON.parse(await readFile(path.join(bundle.dir, 'templates', 'spec.json'), 'utf8'));
  assert.deepEqual(
    spec.tasks.filter(task => task.owner === 'reviewer').map(task => task.id),
    [],
    'the epic gate reviews; a reviewer task is one more wave and one more chat',
  );
  const [first] = spec.tasks;
  assert.deepEqual(first.dependsOn, []);
  assert.ok(
    first.writePaths.some(item => /^tests?\//.test(item)),
    'the first task writes a minimal test: a check that passes no test fails',
  );
  const { snapshot } = await project(t, { scaffold: 'accepted' });
  const extended = await prepareExtend({ snapshot, prompt: 'Теги', root: snapshot.project.root, home });
  const milestone = JSON.parse(await readFile(path.join(extended.dir, 'templates', 'milestone.json'), 'utf8'));
  assert.deepEqual(
    milestone.tasks.filter(task => task.owner === 'reviewer').map(task => task.id),
    [],
  );
  assert.deepEqual(lintMilestone(milestone, snapshot), { ok: true, findings: [] });
});

test('prepareExtend names interface evidence by its module, not by its content-addressed file', async t => {
  const { root, snapshot } = await project(t, { scaffold: 'accepted' });
  const home = await temp(t, 'kodo-home-');
  const evidence = path.join(home, 'project-interfaces', 'evidence');
  await mkdir(evidence, { recursive: true });
  const bound = new Map();
  for (const module of ['api', 'storage']) {
    const source = `interfaces/${module}.md`;
    const text = await readFile(path.join(root, '.kodo', 'blueprint', ...source.split('/')), 'utf8');
    const value = { schemaVersion: 1, module, source, sha256: 'b'.repeat(64), bytes: Buffer.byteLength(text), text };
    const body = JSON.stringify({ schemaVersion: 1, kind: 'interface', baseSha: null, headSha: null, value });
    const sha256 = createHash('sha256').update(body).digest('hex');
    const file = path.join(evidence, `interface-${sha256}.json`);
    await writeFile(file, body);
    bound.set(module, { kind: 'interface', runId: null, headSha: null, path: file, sha256 });
  }
  // A ref whose envelope is missing keeps its file name: nothing is guessed.
  const lost = {
    kind: 'interface',
    runId: null,
    headSha: null,
    path: path.join(evidence, `interface-${'c'.repeat(64)}.json`),
    sha256: 'c'.repeat(64),
  };
  const current = structuredClone(snapshot);
  for (const task of current.tasks)
    task.interfaceRefs = task.interfaceRefs.map(ref => bound.get(path.basename(ref.path, '.md')) ?? ref);
  current.tasks.find(task => task.id === 'web-module').interfaceRefs = [lost];
  const result = await prepareExtend({ snapshot: current, prompt: 'Теги', root, home, now: AT });
  const context = await readFile(path.join(result.dir, 'context.md'), 'utf8');
  assert.match(context, /- api-module \[ready\] [^\n]*; interfaces: api\.md, storage\.md\n/);
  assert.doesNotMatch(context, /interface-[a-f0-9]{64}\.json, /);
  assert.match(context, /- web-module \[ready\] [^\n]*; interfaces: interface-c{64}\.json\n/);
});

test('lintMilestone explains that a new milestone takes interfaceRefs: [] instead of the blueprint short form', async t => {
  const { snapshot } = await project(t, { 'storage-module': 'accepted' });
  const short = milestoneFile({ index: { interfaceRefs: [{ kind: 'interface', path: 'interfaces/storage.md' }] } });
  const result = lintMilestone(short, snapshot);
  assert.deepEqual(codes(result), ['milestone_interface_unbound']);
  assert.deepEqual(result.findings[0].taskIds, ['search-index']);
  assert.match(result.findings[0].message, /interfaceRefs: \[\]/);
  const { dir } = await prepareExtend({
    snapshot,
    prompt: 'Поиск',
    root: snapshot.project.root,
    home: await temp(t, 'kodo-home-'),
  });
  const rules = await readFile(path.join(dir, 'rules.md'), 'utf8');
  assert.match(rules, /interfaceRefs: \[\]/);
  assert.ok(rules.includes('milestone_interface_unbound'));
});
