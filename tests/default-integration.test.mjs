import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';

const expected = [
  'skills/architecture-patterns','skills/architecture-decision-records','skills/monorepo-management','skills/e2e-testing-patterns',
  'skills/subagent-driven-development','skills/systematic-debugging','skills/test-driven-development','skills/using-git-worktrees',
  'skills/differential-review','skills/react-best-practices','skills/composition-patterns','skills/ce-compound','skills/spec-kit'
];
const read = filename => readFile(filename, 'utf8');
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function projectFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-default-integration-'));
  const project = path.join(directory, 'project');
  const home = path.join(directory, 'state');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src/value.mjs'), 'export const value = 7;\n');
  await writeFile(path.join(project, 'verify.mjs'), "import './tests/contract.mjs';\n");
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({
    schemaVersion: 1, client: 'codex', concurrency: 2, repairRounds: 1, researchBudget: 4,
    commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [], deploy: [], smoke: [] },
    delivery: { enabled: false, release: false }
  }));
  git(project, 'init', '-b', 'main');
  git(project, 'config', 'core.autocrlf', 'false');
  git(project, 'config', 'user.name', 'Kodo Default Integration Test');
  git(project, 'config', 'user.email', 'default-integration@example.invalid');
  git(project, 'add', '.'); git(project, 'commit', '-m', 'Fixture baseline');
  const base = git(project, 'rev-parse', 'HEAD');
  const store = new Store(home);
  t.after(async () => {
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kodo-default-integration-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { directory, project: git(project, 'rev-parse', '--show-toplevel'), home, base, store };
}

function services({ failWorker = false } = {}) {
  const calls = { analyses: [], sessions: [] };
  const plan = { summary: 'Expose value eight with a contract test and usage documentation.', tasks: [
    { id: 'feature', role: 'developer', description: 'Set the value export to eight', dependsOn: [], writePaths: ['src/value.mjs'], acceptance: ['The public value export is eight'], parallel: false },
    { id: 'contract', role: 'tester', description: 'Test the public value contract', dependsOn: ['feature'], writePaths: ['tests/contract.mjs'], acceptance: ['The contract test asserts value eight independently'], parallel: true },
    { id: 'documentation', role: 'documenter', description: 'Document the value export', dependsOn: ['feature'], writePaths: ['docs/usage.md'], acceptance: ['The usage documentation reflects value eight'], parallel: true }
  ] };
  const provider = {
    analyzeGemini: async request => {
      calls.analyses.push(request);
      assert.match(request.task, /Kodo default skill policy v1, stage analyze/);
      assert.match(request.task, /All 13 bundled skills were evaluated/);
      return { summary: 'The fixture has one public value module.', model: 'gemini-fixture', files: request.files.map(item => item.path), limitations: [] };
    },
    discoverProviders: async () => [
      { id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true },
      { id: 'codex-astra', client: 'codex', model: 'gpt-6-astra', available: true }
    ],
    decideJev: async () => ({ model: 'codex-sol', confidence: 0.99, parallel: true, sessionMode: 'fresh' }),
    runSession: async request => {
      calls.sessions.push(request);
      let output;
      if (request.schema.properties.tasks) {
        assert.match(request.prompt, /Kodo default skill policy v1, stage plan/);
        output = plan;
      } else if (request.schema.properties.passed) {
        assert.match(request.prompt, /Kodo default skill policy v1, stage review/);
        assert.match(request.prompt, /Security-focused code review/);
        assert.equal(request.readOnly, true);
        output = { passed: true, findings: [] };
      } else {
        const role = /Complete this (developer|tester|documenter) task/.exec(request.prompt)?.[1];
        assert.ok(role);
        assert.match(request.prompt, new RegExp(`Kodo default skill policy v1, stage ${role}`));
        if (failWorker) return { sessionId: 'failed-worker', output: { summary: 'fixture cannot verify requested behavior', checks: [], complete: false } };
        if (role === 'developer') await writeFile(path.join(request.cwd, 'src/value.mjs'), 'export const value = 8;\n');
        if (role === 'tester') {
          await mkdir(path.join(request.cwd, 'tests'), { recursive: true });
          await writeFile(path.join(request.cwd, 'tests/contract.mjs'), "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,8);\n");
        }
        if (role === 'documenter') {
          await mkdir(path.join(request.cwd, 'docs'), { recursive: true });
          await writeFile(path.join(request.cwd, 'docs/usage.md'), 'The public value export is 8.\n');
        }
        output = { summary: `${role} finished`, checks: ['fixture contract checked'], complete: true };
      }
      const sessionId = `default-session-${calls.sessions.length}`;
      request.onEvent({ sessionId });
      return { sessionId, output };
    }
  };
  return { provider, researcher: async () => ({ items: [], requests: 0, errors: [], cache: [] }), calls };
}

test('Engine records every default skill at each completed role and carries checked knowledge into a subsequent analysis', async t => {
  const fx = await projectFixture(t), injected = services();
  const engine = new Engine({ store: fx.store, ...injected });
  const run = await engine.create('Expose value eight with tests and docs', { project: fx.project });
  const completed = await engine.run(run.id);
  assert.equal(completed.state, 'succeeded', completed.error?.message);
  const persisted = fx.store.getRun(run.id);
  for (const stage of ['analyze','plan','developer','tester','documenter','review','complete']) {
    const record = persisted.defaultSkills[stage];
    assert.ok(record, stage);
    assert.match(record.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(record.skills.map(item => item.id), expected, stage);
    assert.ok(record.skills.every(item => typeof item.applies === 'boolean' && item.reason && /^[a-f0-9]{40}$/.test(item.revision)), stage);
  }
  assert.equal(persisted.defaultSkills.complete.skills.find(item => item.id === 'skills/ce-compound').applies, true);
  assert.equal(persisted.defaultSkills.developer.skills.find(item => item.id === 'skills/react-best-practices').applies, false);
  assert.equal(persisted.defaultSkills.plan.skills.find(item => item.id === 'skills/monorepo-management').applies, false);
  assert.equal(persisted.checks.headSha, persisted.headSha);
  assert.equal(persisted.review.headSha, persisted.headSha);
  assert.equal(persisted.review.passed, true);
  const lessons = fx.store.lessons(fx.project);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].runId, completed.id);
  assert.equal(lessons[0].headSha, completed.headSha);
  assert.equal(lessons[0].review.headSha, completed.headSha);
  assert.ok(lessons[0].checks.every(item => item.exitCode === 0));
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 7;\n');
  assert.equal(git(fx.project, 'rev-parse', 'HEAD'), fx.base);

  const next = await engine.create('Inspect the checked value behavior for a follow-up', { project: fx.project });
  const prepared = await engine.run(next.id, { prepare: true });
  assert.equal(prepared.state, 'awaiting_plan');
  assert.equal(prepared.analysis.priorLessons.length, 1);
  assert.equal(prepared.analysis.priorLessons[0].headSha, completed.headSha);
  assert.equal(prepared.analysis.priorLessons[0].runId, completed.id);
  assert.equal(injected.calls.analyses.length, 2);
  const planContext = await read(path.join(prepared.artifacts, 'plan-context.md'));
  assert.equal(planContext, prepared.planningContext);
  assert.match(planContext, /Kodo default skill policy v1, stage plan/);
  assert.ok(expected.every(id => planContext.includes(id)));
  await access(path.join(prepared.artifacts, 'plan.schema.json'));
  assert.ok(!prepared.artifacts.startsWith(fx.project + path.sep));
  assert.equal(fx.store.lessons(fx.project).length, 1, 'analysis-only run must not become verified knowledge');
});

test('Engine does not remember an unverified failed run or feed it into subsequent planning', async t => {
  const fx = await projectFixture(t), injected = services({ failWorker: true });
  const engine = new Engine({ store: fx.store, ...injected });
  const run = await engine.create('Expose value eight', { project: fx.project });
  const failed = await engine.run(run.id);
  assert.equal(failed.state, 'blocked');
  assert.match(failed.error.message, /не завершил задачу/);
  assert.equal(failed.knowledge, undefined);
  assert.equal(failed.defaultSkills.complete, undefined);
  assert.deepEqual(fx.store.lessons(fx.project), []);
  const next = await engine.create('Inspect the unmodified module', { project: fx.project });
  const prepared = await engine.run(next.id, { prepare: true });
  assert.equal(prepared.state, 'awaiting_plan');
  assert.deepEqual(prepared.analysis.priorLessons, []);
  assert.deepEqual(fx.store.lessons(fx.project), []);
  assert.equal(await read(path.join(fx.project, 'src/value.mjs')), 'export const value = 7;\n');
});
