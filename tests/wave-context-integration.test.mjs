import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.mjs';
import { Engine } from '../runtime/engine.mjs';
import * as contracts from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { completeTask, nextWave } from '../runtime/project-external.mjs';
import { recordGateLesson } from '../runtime/wave-verifier.mjs';
import { MAX_TASK_MODULES, MAX_TASK_WRITE_PATHS, compileBlueprint } from '../runtime/project-blueprint.mjs';
import { buildContextManifest } from '../runtime/context-manifest.mjs';

const blueprintFixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blueprint');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function write(cwd, relativePath, content) {
  const full = path.join(cwd, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

async function commit(cwd, files, message = 'Change') {
  for (const [name, text] of Object.entries(files)) await write(cwd, name, text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function blueprintCopy(t, mutate) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-bp-15d-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.kodo', 'blueprint');
  await cp(path.join(blueprintFixtures, 'valid'), dir, { recursive: true });
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  spec.root = root;
  mutate?.(spec);
  await writeFile(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  return { root, dir };
}

test('blueprint linter rejects task without unambiguous owner, shared-file wave collision, and oversized scope', async t => {
  // (a1) Unbounded catch-all writePaths
  const catchAll = await blueprintCopy(t, spec => {
    spec.tasks.find(item => item.id === 'web-module').writePaths = ['src/**'];
  });
  const catchAllRes = await compileBlueprint(catchAll.root);
  assert.equal(catchAllRes.ok, false);
  assert.ok(
    catchAllRes.findings.some(f => f.code === 'blueprint_owner_ambiguous' && f.taskIds?.includes('web-module')),
    JSON.stringify(catchAllRes.findings),
  );

  // (a2) Two sequential tasks in different epics claiming ownership of the same module
  const multiOwner = await blueprintCopy(t, spec => {
    const api = spec.tasks.find(item => item.id === 'api-module');
    api.dependsOn = ['storage-module'];
    api.writePaths = ['src/api', 'src/storage/extra.mjs'];
  });
  const multiOwnerRes = await compileBlueprint(multiOwner.root);
  assert.equal(multiOwnerRes.ok, false);
  assert.ok(
    multiOwnerRes.findings.some(
      f =>
        f.code === 'blueprint_owner_ambiguous' &&
        f.taskIds?.includes('storage-module') &&
        f.taskIds?.includes('api-module'),
    ),
    JSON.stringify(multiOwnerRes.findings),
  );

  // (b) Two tasks in the same wave colliding on root Cargo.toml / package.json / entrypoint -> integrator_required
  const sharedFile = await blueprintCopy(t, spec => {
    spec.tasks.find(item => item.id === 'storage-module').writePaths = ['src/storage', 'Cargo.toml'];
    spec.tasks.find(item => item.id === 'api-module').writePaths = ['src/api', 'Cargo.toml'];
  });
  const sharedRes = await compileBlueprint(sharedFile.root);
  assert.equal(sharedRes.ok, false);
  assert.ok(
    sharedRes.findings.some(
      f =>
        f.code === 'integrator_required' && f.taskIds?.includes('storage-module') && f.taskIds?.includes('api-module'),
    ),
    JSON.stringify(sharedRes.findings),
  );

  const entryCollision = await blueprintCopy(t, spec => {
    spec.tasks.find(item => item.id === 'storage-module').writePaths = ['src/storage', 'src/main.rs'];
    spec.tasks.find(item => item.id === 'web-module').writePaths = ['src/web', 'src/main.rs'];
  });
  const entryRes = await compileBlueprint(entryCollision.root);
  assert.ok(
    entryRes.findings.some(f => f.code === 'integrator_required'),
    JSON.stringify(entryRes.findings),
  );

  // (c1) Oversized task by writePaths count -> split_required
  const tooManyPaths = await blueprintCopy(t, spec => {
    spec.tasks.find(item => item.id === 'storage-module').writePaths = Array.from(
      { length: MAX_TASK_WRITE_PATHS + 1 },
      (_, i) => `src/storage/part-${i}.mjs`,
    );
  });
  const pathsRes = await compileBlueprint(tooManyPaths.root);
  assert.equal(pathsRes.ok, false);
  assert.ok(
    pathsRes.findings.some(f => f.code === 'split_required' && f.taskIds?.includes('storage-module')),
    JSON.stringify(pathsRes.findings),
  );

  // (c2) Oversized task by distinct modules count -> split_required
  const tooManyModules = await blueprintCopy(t, spec => {
    spec.tasks.find(item => item.id === 'storage-module').writePaths = Array.from(
      { length: MAX_TASK_MODULES + 1 },
      (_, i) => `crates/mod${i}`,
    );
  });
  const modRes = await compileBlueprint(tooManyModules.root);
  assert.equal(modRes.ok, false);
  assert.ok(
    modRes.findings.some(f => f.code === 'split_required' && f.taskIds?.includes('storage-module')),
    JSON.stringify(modRes.findings),
  );
});

test('wave brief embeds mandatory API card via ContextManifest, attaches diagnostic pack on retry, and scopes gate lessons by module', async t => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kodo-wave-15d-')));
  const stores = [];
  t.after(async () => {
    for (const s of stores) s.close();
    await rm(temp, { recursive: true, force: true });
  });

  const root = path.join(temp, 'project');
  await mkdir(root, { recursive: true });
  const config = {
    schemaVersion: 1,
    repository: 'fixture/Kodo',
    client: 'codex',
    baseBranch: 'main',
    concurrency: 1,
    repairRounds: 2,
    researchBudget: 0,
    commands: { test: [{ command: process.execPath, args: ['--test'] }], build: [], deploy: [], smoke: [] },
    checks: [],
    delivery: { enabled: false, release: false, firstVersion: '0.2.0' },
  };
  await write(root, '.gitattributes', '* text=auto eol=lf\n');
  await write(root, 'kodo.config.json', JSON.stringify(config, null, 2));
  await write(
    root,
    '.kodo/blueprint/PROJECT.md',
    '# Demo\n## Цель\nДемо\n## Инварианты\n- Только чистые функции в storage.\n',
  );
  await write(root, 'src/storage/index.mjs', 'export function loadItem(id) { return id; }\nfunction priv() {}\n');
  await write(
    root,
    'tests/storage.test.mjs',
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadItem } from '../src/storage/index.mjs';\ntest('loads item', () => assert.equal(loadItem(1), 1));\n`,
  );
  await write(root, 'src/api/index.mjs', 'export const apiVersion = 1;\n');
  await write(
    root,
    'tests/api.test.mjs',
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { apiVersion } from '../src/api/index.mjs';\ntest('api version', () => assert.equal(apiVersion, 1));\n`,
  );
  await write(root, 'src/web/index.mjs', 'export const title = "demo";\n');
  await write(
    root,
    'tests/web.test.mjs',
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { title } from '../src/web/index.mjs';\ntest('web title', () => assert.equal(title, 'demo'));\n`,
  );

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Wave 15D');
  git(root, 'config', 'user.email', 'kodo-15d@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Baseline');

  const home = path.join(temp, 'state');
  const store = new Store(home);
  stores.push(store);
  const engine = new Engine({ store });
  const repo = await openProjectStore({
    store,
    contracts,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts }),
  });

  const criterion = { id: 'ok', text: 'Passes tests', evidenceKinds: ['checks'] };
  const makeTask = (id, epicId, extra = {}) => ({
    id,
    epicId,
    title: `Task ${id}`,
    description: `Implement ${id}`,
    owner: 'developer',
    dependsOn: [],
    writePaths: [`src/${epicId}`],
    acceptance: [criterion],
    interfaceRefs: [],
    priority: 50,
    userValue: 3,
    risk: 1,
    estimatedEffort: 1,
    riskApprovalRequired: false,
    ...extra,
  });

  const spec = {
    schemaVersion: 1,
    id: 'wave-15d',
    root,
    title: 'Wave 15D Fixture',
    definitionOfDone: [criterion],
    constraints: ['No external network calls.'],
    businessContext: 'Test wave context',
    architectureRefs: [],
    execution: { cadence: 'wave', integration: 'branch' },
    milestones: [{ id: 'm1', title: 'M1', acceptance: [criterion], releaseRequired: false }],
    epics: [
      { id: 'storage', milestoneId: 'm1', title: 'Storage', acceptance: [criterion] },
      { id: 'api', milestoneId: 'm1', title: 'API', acceptance: [criterion] },
      { id: 'web', milestoneId: 'm1', title: 'Web', acceptance: [criterion] },
    ],
    tasks: [
      makeTask('storage-1', 'storage', {
        writePaths: ['src/storage/index.mjs', 'tests/storage.test.mjs'],
        priority: 90,
      }),
      makeTask('storage-2', 'storage', {
        dependsOn: ['storage-1'],
        writePaths: ['src/storage/extra.mjs'],
        priority: 80,
      }),
      makeTask('api-1', 'api', {
        dependsOn: ['storage-1'],
        writePaths: ['src/api/index.mjs', 'tests/api.test.mjs'],
        priority: 70,
      }),
      makeTask('web-1', 'web', {
        writePaths: ['src/web/index.mjs', 'tests/web.test.mjs'],
        priority: 60,
      }),
    ],
  };

  const created = await repo.apply({
    schemaVersion: 1,
    commandId: randomUUID(),
    projectId: null,
    expectedRevision: null,
    actor: 'test',
    reason: 'Create project',
    action: { op: 'create', spec },
  });
  const projectId = created.projectId;
  const ctx = { repo, engine, store, contracts };

  // Record a verified gate lesson for epic/module `storage`
  const headSha = git(root, 'rev-parse', 'HEAD');
  recordGateLesson(engine, {
    id: 'gate-storage-run',
    project: root,
    headSha,
    directorBinding: { kind: 'gate', projectId, gateId: 'gate-storage-1' },
    gateScope: { epicIds: ['storage'], modules: ['storage'], writePaths: ['src/storage'] },
    checks: { complete: true, headSha, results: [{ command: { command: 'node', args: ['--test'] }, exitCode: 0 }] },
    review: {
      passed: true,
      headSha,
      lesson: 'Keep storage helpers pure and synchronous without global mutable caches.',
      findings: [
        { file: 'src/storage/index.mjs', severity: 'minor', problem: 'RAW_REVIEW_TEXT_DO_NOT_LEAK', fix: 'n/a' },
      ],
    },
  });

  // Step 1: Request first wave (`storage-1` and `web-1` are ready)
  const wave1 = await nextWave(ctx, { projectId, host: 't3', limit: 3 });
  const storageBrief = wave1.briefs.find(b => b.taskId === 'storage-1');
  const webBrief = wave1.briefs.find(b => b.taskId === 'web-1');
  assert.ok(storageBrief);
  assert.ok(webBrief);

  // ContextManifest includes mandatory api-cards section
  assert.equal(storageBrief.contextManifest.kind, 'context-manifest');
  const apiSection = storageBrief.contextManifest.sections.find(s => s.name === 'api-cards');
  assert.ok(apiSection && apiSection.mandatory === true && apiSection.bytes > 0);
  // Attempting to mark api-cards as truncated must be rejected by ContextManifest
  assert.throws(
    () =>
      buildContextManifest({
        runId: storageBrief.runId,
        stage: 'wave-brief',
        node: 'storage-1',
        headSha: storageBrief.baseSha,
        sections: [
          { name: 'instructions', bytes: 100, mandatory: true },
          {
            name: 'api-cards',
            bytes: 100,
            mandatory: true,
            truncated: true,
            omitted: [{ field: 'modules', items: 1 }],
          },
        ],
      }),
    err => err.code === 'context_manifest_invalid',
  );

  // Verified lesson of `storage` appears in `storage-1` brief and NOT in unrelated `web-1` brief
  assert.ok(storageBrief.verifiedLessons?.length === 1);
  assert.match(storageBrief.verifiedLessons[0].summary, /Keep storage helpers pure/);
  assert.match(storageBrief.prompt, /Keep storage helpers pure/);
  assert.doesNotMatch(JSON.stringify(storageBrief), /RAW_REVIEW_TEXT_DO_NOT_LEAK/);
  assert.equal(webBrief.verifiedLessons, undefined, 'unrelated module must not receive storage lesson');
  assert.doesNotMatch(webBrief.prompt, /Keep storage helpers pure/);

  // Step 2: Submit a failing commit for `storage-1` -> completeTask returns diagnostic pack
  const brokenHead = await commit(
    storageBrief.worktree,
    {
      'src/storage/index.mjs': 'export function loadItem(id) { return id + 999; }\n',
    },
    'Break storage test',
  );
  const failed = await completeTask(ctx, {
    projectId,
    taskId: 'storage-1',
    head: brokenHead,
    attemptId: storageBrief.attemptId,
    deferGate: true,
  });
  assert.equal(failed.status, 'checks_failed');
  assert.ok(failed.diagnostics, 'completeTask must return diagnostic pack on failure');
  assert.equal(failed.diagnostics.kind, 'diagnostic-pack');
  assert.ok(failed.diagnostics.failingTests.includes('loads item'));
  assert.ok(failed.diagnostics.items.length >= 1);

  // Abandon attempt 1 and retry -> retry brief must carry the diagnostic pack!
  const abandoned = await completeTask(ctx, {
    projectId,
    taskId: 'storage-1',
    head: brokenHead,
    attemptId: storageBrief.attemptId,
    abandon: true,
  });
  assert.equal(abandoned.status, 'abandoned');

  const retryWave = await nextWave(ctx, { projectId, host: 't3', limit: 3, retryFailed: true });
  const retryBrief = retryWave.briefs.find(b => b.taskId === 'storage-1');
  assert.ok(retryBrief);
  assert.ok(retryBrief.diagnostics, 'retry brief must carry diagnostic pack from previous failed attempt');
  assert.ok(retryBrief.diagnostics.failingTests.includes('loads item'));
  assert.match(retryBrief.prompt, /loads item/);

  // Step 3: Fix `storage-1`, integrate it, then check `api-1` brief gets `storage-1`'s public API card at baseSha
  const fixedHead = await commit(
    retryBrief.worktree,
    {
      'src/storage/index.mjs':
        'export function loadItem(id) { return id; }\nexport function deleteItem(id) { return Boolean(id); }\nfunction secretInternal() {}\n',
    },
    'Fix storage and add deleteItem',
  );
  const integrated = await completeTask(ctx, {
    projectId,
    taskId: 'storage-1',
    head: fixedHead,
    attemptId: retryBrief.attemptId,
    deferGate: true,
  });
  assert.equal(integrated.status, 'integrated');

  const wave2 = await nextWave(ctx, { projectId, host: 't3', limit: 4 });
  const apiBrief = wave2.briefs.find(b => b.taskId === 'api-1');
  const storage2Brief = wave2.briefs.find(b => b.taskId === 'storage-2');
  assert.ok(apiBrief);
  assert.ok(storage2Brief);
  // `api-1` depends on `storage-1`: its API card must show `loadItem` and `deleteItem` from baseSha, and NOT `secretInternal`
  assert.match(apiBrief.prompt, /export function deleteItem\(id\)/);
  assert.doesNotMatch(apiBrief.prompt, /secretInternal/);
  assert.equal(apiBrief.verifiedLessons, undefined, 'api module must not receive storage-only lesson');
  // `storage-2` is in epic `storage`: receives storage lesson AND storage-1 API card
  assert.ok(storage2Brief.verifiedLessons?.length === 1);
  assert.match(storage2Brief.prompt, /Keep storage helpers pure/);
  assert.match(storage2Brief.prompt, /export function deleteItem\(id\)/);
});
