import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../runtime/engine.mjs';
import { Store } from '../../runtime/store.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}

const choice = (options, selected) => ({ type: 'choice', choice: selected, confidence: .9, probabilities: Object.fromEntries(options.map(option => [option, option === selected ? .9 : .05])) });

const low = () => ({ fallback: false, complexity: choice(['low','medium','high'], 'low'), risk: choice(['low','medium','high'], 'low'), scope: choice(['local','module','cross-cutting'], 'local'), requests: 1 });

const high = () => ({ ...low(), risk: choice(['low','medium','high'], 'high') });

const task = id => ({ id, role: 'developer', description: 'Set exported value to one with its checks', writePaths: ['value.mjs'], dependsOn: [], acceptance: ['Export equals one; test and build pass'], parallel: false });

const onePlan = () => ({ summary: 'One localized deliverable including verification', tasks: [task('fix')] });

const metrics = () => ({ durationMs: 2, toolSteps: 1, nativeRequestCount: null, usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 12, semantics: 'input-includes-cached', source: 'codex.usage' } });

async function fixture(t, { config = {}, assessment = low, plan = onePlan, failedCheck = false, failedReview = false, failedWorker = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-mode-engine-')), project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'value.mjs'), 'export const value = 0;\n');
  await writeFile(path.join(project, 'verify.mjs'), `import assert from 'node:assert/strict'; import {value} from './value.mjs'; assert.equal(value, ${failedCheck ? 2 : 1});\n`);
  await writeFile(path.join(project, 'build.mjs'), "import {value} from './value.mjs'; if(value!==1) process.exit(1);\n");
  await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ commands: { test: [{ command: process.execPath, args: ['verify.mjs'] }], build: [{ command: process.execPath, args: ['build.mjs'] }] }, ...config }));
  git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Mode Engine Test'); git(project, 'config', 'user.email', 'mode@example.invalid'); git(project, 'config', 'core.autocrlf', 'false'); git(project, 'add', '.'); git(project, 'commit', '-m', 'Initial fixture');
  const store = new Store(path.join(root, 'state'));
  t.after(async () => { store.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('kodo-mode-engine-')); await rm(root, { recursive: true, force: true }); });
  const calls = [], sessions = [];
  const provider = {
    assessTask: async request => { calls.push('assessment'); assert.ok(request.files.length <= 32); return assessment(request); },
    analyzeGemini: async () => { calls.push('analysis'); return { summary: 'Fixture analysis', model: 'offline-gemini', files: [], limitations: [] }; },
    discoverProviders: async () => { calls.push('discovery'); return [ { id: 'sol', client: 'codex', model: 'gpt-6.1-sol', available: true }, { id: 'astra', client: 'codex', model: 'gpt-6-astra', available: true } ]; },
    decideJev: async request => { calls.push('routing'); return { model: request.models.find(model => model.id === 'astra')?.id || request.models[0].id, confidence: .1, parallel: true }; },
    runSession: async request => {
      sessions.push(request);
      const stage = request.schema.properties.tasks ? 'plan' : request.schema.properties.passed ? 'review' : 'worker'; calls.push(stage);
      const sessionId = `session-${sessions.length}`; request.onEvent?.({ sessionId });
      if (stage === 'plan') return { sessionId, metrics: metrics(), output: plan() };
      if (stage === 'review') {
        assert.equal(request.readOnly, true); assert.equal(request.sessionId, undefined, 'independent fresh review');
        return { sessionId, metrics: metrics(), output: { passed: !failedReview, findings: failedReview ? [{ file: 'value.mjs', severity: 'major', problem: 'Confirmed missing edge case', fix: 'Preserve the edge case' }] : [] } };
      }
      if (failedWorker) throw Object.assign(new Error('Native fixture failure'), { code: 'quota', metrics: metrics() });
      await writeFile(path.join(request.cwd, 'value.mjs'), 'export const value = 1;\n');
      return { sessionId, metrics: metrics(), output: { complete: true, summary: 'Export updated', checks: ['targeted value assertion'] } };
    }
  };
  const engine = new Engine({ store, provider, researcher: async () => { calls.push('research'); return { requests: 0, items: [], errors: [], cache: [] }; } });
  return { root, project, store, engine, calls, sessions, provider };
}

export { git, choice, low, high, task, onePlan, metrics, fixture };
