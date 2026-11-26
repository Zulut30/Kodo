import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Engine } from '../runtime/engine.mjs';
import { Store } from '../runtime/store.mjs';
import * as A from '../runtime/project-contracts.mjs';
import { openProjectStore } from '../runtime/project-store.mjs';
import { createProjectDirector, createProjectTransitionAuthorizer } from '../runtime/project-director.mjs';
import { runEpicGate } from '../runtime/wave-verifier.mjs';
import { reportCli } from '../runtime/report-cli.mjs';
import {
  ARBITER_MAX_ATTEMPTS,
  arbiterContract,
  arbiterRetryAllowed,
  arbitrationAccepts,
  arbitrationOf,
  reviewReceiptHash,
  selectArbiter,
} from '../runtime/gate-arbiter.mjs';
import { confirmedCriteria } from './helpers/gate-review.mjs';

// Kodo 16B1: the gate arbiter on another subscription of the project's execution profile.

const sha = char => char.repeat(40);
const subscription = (id, provider, model, tier = 'standard', extra = {}) => ({
  id,
  provider,
  model,
  slots: 1,
  tier,
  ...extra,
});
const profileOf = (...subscriptions) => ({
  schemaVersion: 1,
  subscriptions,
  machines: [{ id: 'local', kind: 'local', maxWorkers: 4, maxHeavyBuilds: 1 }],
});
const twoProviders = () =>
  profileOf(subscription('gpt', 'codex', 'gpt-6.1-sol', 'heavy'), subscription('claude', 'claude-code', 'opus'));

test('selectArbiter needs two providers and picks an active subscription of another client', () => {
  const now = Date.parse('2026-11-25T00:00:00Z');
  assert.equal(selectArbiter(null, { reviewerClient: 'codex', now }), null, 'no profile');
  assert.equal(
    selectArbiter(profileOf(subscription('gpt', 'codex', 'gpt-6.1-sol')), { reviewerClient: 'codex', now }),
    null,
    'one subscription',
  );
  assert.equal(
    selectArbiter(profileOf(subscription('a', 'codex', 'gpt-6.1-sol'), subscription('b', 'openai', 'gpt-6-astra')), {
      reviewerClient: 'codex',
      now,
    }),
    null,
    'two subscriptions of one client',
  );
  assert.equal(
    selectArbiter(profileOf(subscription('a', 'codex', 'gpt-6.1-sol'), subscription('b', 'antigravity', 'gemini')), {
      reviewerClient: 'codex',
      now,
    }),
    null,
    'an unknown provider is no arbiter',
  );
  assert.deepEqual(selectArbiter(twoProviders(), { reviewerClient: 'codex', now }), {
    subscriptionId: 'claude',
    provider: 'claude-code',
    client: 'claude-code',
    model: 'opus',
  });
  assert.deepEqual(selectArbiter(twoProviders(), { reviewerClient: 'claude-code', now }), {
    subscriptionId: 'gpt',
    provider: 'codex',
    client: 'codex',
    model: 'gpt-6.1-sol',
  });
  const paused = profileOf(
    subscription('gpt', 'codex', 'gpt-6.1-sol'),
    subscription('claude', 'anthropic', 'opus', 'standard', { cooldownUntil: '2026-12-01T00:00:00Z' }),
  );
  assert.equal(selectArbiter(paused, { reviewerClient: 'codex', now }), null, 'a paused subscription is skipped');
  const tiers = profileOf(
    subscription('gpt', 'codex', 'gpt-6.1-sol'),
    subscription('sonnet', 'claude', 'sonnet', 'fast'),
    subscription('opus', 'claude-code', 'opus', 'heavy'),
  );
  assert.equal(selectArbiter(tiers, { reviewerClient: 'codex', now }).subscriptionId, 'opus', 'heaviest tier first');
});

const contract = arbiterContract(['task:alpha:alpha-proof', 'epic:e1:e1-proof'], 1);
const answer = (overrides = {}) => ({
  decision: 'confirm_pass',
  rationale: 'The finding is a style preference outside the gate criteria.',
  evidence: {
    criteria: [
      { id: 'task:alpha:alpha-proof', met: true, evidence: 'alpha.txt holds the implementation' },
      { id: 'epic:e1:e1-proof', met: true, evidence: 'The epic requirement is observable' },
    ],
    findings: [{ index: 0, confirmed: false, reason: 'Wording only' }],
  },
  splitWork: null,
  ...overrides,
});

test('arbitrationOf validates the decision and refuses inconsistent or malformed output', () => {
  assert.equal(arbitrationOf(contract, answer()).decision, 'confirm_pass');
  const invalid = output => assert.throws(() => arbitrationOf(contract, output), { code: 'invalid_output' });
  invalid({ decision: 'confirm_pass' });
  invalid(answer({ rationale: 'x'.repeat(4001) }));
  invalid(answer({ decision: 'approve' }));
  invalid(answer({ splitWork: [], decision: 'split_needed' }));
  const unmet = answer();
  unmet.evidence.criteria[1].met = false;
  invalid(unmet);
  const confirmed = answer();
  confirmed.evidence.findings[0].confirmed = true;
  invalid(confirmed);
  const duplicate = answer();
  duplicate.evidence.criteria[1].id = 'task:alpha:alpha-proof';
  invalid(duplicate);
  const split = answer({
    decision: 'split_needed',
    splitWork: [{ title: 'Persist scores', description: 'Add storage', writePaths: ['storage/**'] }],
  });
  assert.equal(arbitrationOf(contract, split).splitWork.length, 1);
});

test('arbitrationAccepts binds confirm_pass to the verified head, the review receipt and another client', () => {
  const review = { passed: false, headSha: sha('b'), sessionId: 'review-2', findings: [], criteria: [] };
  const run = {
    directorBinding: { kind: 'gate' },
    headSha: sha('b'),
    gateCriteria: [{ id: 'task:alpha:alpha-proof' }],
    review,
    gateArbitration: {
      schemaVersion: 1,
      status: 'decided',
      decision: 'confirm_pass',
      client: 'claude-code',
      reviewerClient: 'codex',
      model: 'opus',
      headSha: sha('b'),
      reviewSessionId: 'review-2',
      reviewHash: reviewReceiptHash(review),
      evidence: {
        criteria: [{ id: 'task:alpha:alpha-proof', met: true, evidence: 'holds' }],
        findings: [{ index: 0, confirmed: false, reason: 'style' }],
      },
      receipt: { path: '/evidence/gate-arbitration.json', sha256: 'c'.repeat(64) },
    },
  };
  assert.equal(arbitrationAccepts(run), true);
  assert.equal(
    arbitrationAccepts({ ...run, gateArbitration: { ...run.gateArbitration, status: 'started' } }),
    false,
    'a started session decided nothing',
  );
  const changed = mutate => {
    const copy = structuredClone(run);
    mutate(copy);
    return arbitrationAccepts(copy);
  };
  assert.equal(
    changed(copy => (copy.gateArbitration.headSha = sha('d'))),
    false,
    'another head',
  );
  assert.equal(
    changed(copy => (copy.headSha = sha('d'))),
    false,
    'the verified head moved',
  );
  assert.equal(
    changed(copy => copy.review.findings.push({ severity: 'major' })),
    false,
    'another review receipt',
  );
  assert.equal(
    changed(copy => (copy.gateArbitration.client = 'codex')),
    false,
    'the reviewer client',
  );
  assert.equal(
    changed(copy => (copy.gateArbitration.decision = 'confirm_defect')),
    false,
  );
  assert.equal(
    changed(copy => (copy.gateArbitration.invalid = 'invalid_output')),
    false,
  );
  assert.equal(
    changed(copy => (copy.directorBinding.kind = 'task')),
    false,
    'gate Runs only',
  );
  assert.equal(
    changed(copy => (copy.gateArbitration.evidence.criteria[0].met = false)),
    false,
  );
});

// --- integration: the real Engine and Project Director with fake subscription clients ----------

const wave = { cadence: 'wave', integration: 'branch' };
const proof = id => ({ id, text: 'The observable wave requirement holds.', evidenceKinds: ['acceptance'] });
const task = (id, overrides = {}) => ({
  id,
  epicId: 'e1',
  title: `Task ${id}`,
  description: `Implement task ${id}.`,
  owner: 'developer',
  dependsOn: [],
  writePaths: [`${id}.txt`],
  acceptance: [proof(`${id}-proof`)],
  interfaceRefs: [],
  priority: 50,
  userValue: 1,
  risk: 1,
  estimatedEffort: 1,
  riskApprovalRequired: false,
  ...overrides,
});
const envKeys = [
  'HOME',
  'USERPROFILE',
  'KODO_HOME',
  'KODO_CREDENTIAL_HOME',
  'KODO_WORKTREE_HOME',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
];
const STYLE = { file: 'alpha.txt', severity: 'major', problem: 'Prefer another wording (style)', fix: 'Reword it' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

/** The arbiter answer for a request schema: every criterion met, every finding refuted, then `change`. */
function arbiterAnswer(schema, change = value => value) {
  const evidence = schema.properties.evidence.properties;
  const ids = evidence.criteria.items.properties.id.enum;
  const findings = evidence.findings.minItems;
  return change({
    decision: 'confirm_pass',
    rationale: 'The only finding is a wording preference outside the gate criteria.',
    evidence: {
      criteria: ids.map(id => ({ id, met: true, evidence: `Arbiter checked ${id}` })),
      findings: Array.from({ length: findings }, (_, index) => ({ index, confirmed: false, reason: 'Style only' })),
    },
    splitWork: null,
  });
}

/** Fake subscription clients: planner, workers, gate reviews that refuse and the arbiter. */
function providers({ review = 'refuse', arbiter = schema => arbiterAnswer(schema) } = {}) {
  const calls = { reviews: [], repairs: 0, arbiter: [], discovery: [] };
  const provider = {
    assessTask: async () => {
      throw Object.assign(new Error('Offline assessment'), { code: 'unavailable' });
    },
    analyzeGemini: async () => ({ summary: 'Fixture analysis', model: 'offline', files: [], limitations: [] }),
    discoverProviders: async request => {
      calls.discovery.push(request.client);
      return request.client === 'claude-code'
        ? [{ id: 'claude-code:opus', client: 'claude-code', model: 'opus', available: true }]
        : [{ id: 'codex-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }];
    },
    decideJev: async () => ({ model: 'codex-sol', parallel: true, confidence: 0.95, sessionMode: 'fresh' }),
    runSession: async request => {
      if (request.schema?.properties?.decision) {
        calls.arbiter.push(request);
        return { sessionId: `arbiter-${calls.arbiter.length}`, output: arbiter(request.schema, request) };
      }
      if (request.schema?.properties?.tasks) {
        const id = /"taskId":"([a-z][a-z0-9-]*)"/.exec(request.prompt)[1];
        return {
          sessionId: `planner-${id}`,
          output: {
            summary: `Implement ${id}`,
            tasks: [
              {
                id: 'implementation',
                role: 'developer',
                writePaths: [`${id}.txt`],
                dependsOn: [],
                description: `Implement task ${id}.`,
                acceptance: [`${id} exists`],
                parallel: true,
              },
            ],
          },
        };
      }
      if (request.schema?.properties?.passed) {
        calls.reviews.push(request);
        const gate = Boolean(request.schema.properties.criteria);
        const refuse = gate && review === 'refuse';
        return {
          sessionId: `review-${calls.reviews.length}`,
          output: { passed: !refuse, findings: refuse ? [STYLE] : [], ...confirmedCriteria(request.schema) },
        };
      }
      if (/Repair confirmed failures/.test(request.prompt)) {
        calls.repairs++;
        return { sessionId: 'repair', output: { summary: 'Nothing to change', checks: [], complete: true } };
      }
      const id = /Implement task ([a-z][a-z0-9-]*)\./.exec(request.prompt)[1];
      await writeFile(path.join(request.cwd, `${id}.txt`), `${id} implemented\n`);
      request.onEvent?.({ sessionId: `worker-${id}` });
      return { sessionId: `worker-${id}`, output: { summary: `${id} done`, checks: ['written'], complete: true } };
    },
  };
  const delivery = {
    deliver: async () => assert.fail('A wave task never delivers'),
    releasePackage: async () => assert.fail('A wave task never releases'),
  };
  return {
    calls,
    services: { provider, researcher: async () => ({ items: [], requests: 1, errors: [], cache: [] }), delivery },
  };
}

async function fixture(
  t,
  { tasks = [task('alpha')], profile = twoProviders(), smoke = [], failTogether = [], wrapRepo, ...hooks } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-gate-arbiter-'));
  const root = path.join(directory, 'repo'),
    home = path.join(directory, 'state'),
    isolated = path.join(directory, 'empty-home');
  await mkdir(root);
  await mkdir(isolated);
  await writeFile(path.join(isolated, 'gitconfig'), '');
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: isolated,
    USERPROFILE: isolated,
    KODO_HOME: home,
    KODO_CREDENTIAL_HOME: path.join(isolated, 'empty-credentials'),
    KODO_WORKTREE_HOME: path.join(directory, 'worktrees'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(isolated, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  });
  let store;
  t.after(async () => {
    store?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.match(path.basename(directory), /^kodo-gate-arbiter-/);
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    path.join(root, 'kodo.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      client: 'codex',
      executionMode: 'quick',
      maxTasks: 2,
      concurrency: 1,
      researchBudget: 0,
      repairRounds: 1,
      commands: { test: [{ command: process.execPath, args: ['check.mjs'] }], build: [], deploy: [], smoke },
      delivery: { enabled: false, release: false },
      uiVerification: { enabled: false },
      security: { enabled: false },
      architecture: { enabled: false },
    }),
  );
  // Each task passes alone; the combined result of `failTogether` fails (a red deterministic check).
  await writeFile(
    path.join(root, 'check.mjs'),
    `import { existsSync } from 'node:fs';\nconst together = ${JSON.stringify(failTogether)};\n` +
      `if (together.length && together.every(name => existsSync(name))) {\n` +
      `  console.error('combined behaviour fails');\n  process.exit(1);\n}\n`,
  );
  await writeFile(path.join(root, 'smoke.mjs'), "console.error('smoke fails');\nprocess.exit(1);\n");
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Kodo Arbiter Test');
  git(root, 'config', 'user.email', 'kodo-arbiter@example.invalid');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Arbiter fixture baseline');
  store = new Store(home, {});
  const { calls, services } = providers(hooks);
  const engine = new Engine({ store, secrets: {}, leaseHeartbeatMs: 50, ...services });
  const repo = await openProjectStore({
    store,
    contracts: A,
    authorizeTransition: createProjectTransitionAuthorizer({ store, engine, contracts: A }),
  });
  const spec = {
    schemaVersion: 1,
    id: 'arbiter',
    root,
    title: 'Arbiter fixture',
    definitionOfDone: [proof('project-proof')],
    constraints: ['Only the assigned paths.'],
    businessContext: 'Offline gate arbiter fixture.',
    architectureRefs: [],
    milestones: [{ id: 'm1', title: 'Milestone', acceptance: [proof('m1-proof')], releaseRequired: false }],
    epics: [{ id: 'e1', milestoneId: 'm1', title: 'Epic e1', acceptance: [proof('e1-proof')] }],
    tasks,
    execution: wave,
  };
  const id = (
    await repo.apply({
      schemaVersion: 1,
      commandId: randomUUID(),
      projectId: null,
      expectedRevision: null,
      actor: 'arbiter-test',
      reason: 'Observe the gate arbiter',
      action: { op: 'create', spec },
    })
  ).projectId;
  if (profile) repo.setProfile(id, profile);
  const director = createProjectDirector({ repo: wrapRepo ? wrapRepo(repo, store) : repo, engine });
  const gateRun = () => store.getRun(repo.snapshot(id).gates.at(-1).runId);
  // Private report copies live beside the state, never inside it or the credential home.
  const reportPorts = { home, secrets: {}, temporaryRoot: path.join(directory, 'snapshots') };
  await mkdir(reportPorts.temporaryRoot);
  return { root, home, store, engine, repo, id, director, calls, gateRun, reportPorts };
}

test(
  'A refused gate review goes to the arbiter on the other provider: confirm_pass accepts the gate with proof',
  { timeout: 300000 },
  async t => {
    const f = await fixture(t);
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    const gate = f.gateRun();
    const gateReviews = f.calls.reviews.filter(request => request.schema.properties.criteria);
    assert.ok(gateReviews.length >= 2, 'the review refused after a repair round');
    assert.ok(f.calls.repairs >= 1, 'the repair cycle ran before arbitration');
    assert.equal(f.calls.arbiter.length, 1, 'one arbiter session');
    const [arbiter] = f.calls.arbiter;
    assert.equal(arbiter.client, 'claude-code', 'another provider than the codex reviewer');
    assert.equal(arbiter.model, 'opus');
    assert.equal(arbiter.readOnly, true);
    assert.match(arbiter.prompt, /Prefer another wording/, 'the frozen input holds the review findings');
    assert.match(arbiter.prompt, /task:alpha:alpha-proof/, 'and the gate criteria');
    assert.match(arbiter.prompt, /alpha implemented/, 'and the bounded diff');
    assert.equal(gate.state, 'succeeded');
    assert.equal(gate.review.passed, false, 'the refused review stays the review receipt');
    const record = gate.gateArbitration;
    assert.equal(record.decision, 'confirm_pass');
    assert.equal(record.client, 'claude-code');
    assert.equal(record.model, 'opus');
    assert.equal(record.reviewerClient, 'codex');
    assert.equal(record.headSha, gate.headSha);
    assert.equal(record.headSha, gate.review.headSha);
    assert.equal(record.reviewHash, reviewReceiptHash(gate.review));
    assert.ok(record.rationale.length > 0 && record.rationale.length <= 4000);
    assert.ok(record.evidence.criteria.every(row => row.met === true));
    assert.equal(gate.smoke.complete, true);
    const snapshot = f.repo.snapshot(f.id);
    assert.equal(snapshot.project.status, 'accepted');
    assert.deepEqual(
      snapshot.tasks.map(row => row.status),
      ['accepted'],
    );
    const { exitCode, report, output } = await reportCli(['--project', f.id, '--json'], f.reportPorts);
    assert.equal(exitCode, 0, output);
    assert.equal(report.gates[0].arbitration, 'confirm_pass');
    assert.deepEqual(report.totals.gates.arbitrations, {
      total: 1,
      confirm_pass: 1,
      confirm_defect: 0,
      split_needed: 0,
    });
    const human = await reportCli(['--project', f.id], f.reportPorts);
    assert.match(human.output, /^Arbitrations: 1 \(confirm_pass 1, confirm_defect 0, split_needed 0\)$/m);
    assert.match(human.output, / arbiter confirm_pass$/m);
  },
);

test(
  'confirm_defect blocks the gate as before with the arbiter output; the same Run is never arbitrated again',
  { timeout: 300000 },
  async t => {
    const f = await fixture(t, {
      arbiter: schema =>
        arbiterAnswer(schema, value => ({
          ...value,
          decision: 'confirm_defect',
          rationale: 'The wording breaks the documented contract.',
          evidence: { ...value.evidence, findings: value.evidence.findings.map(row => ({ ...row, confirmed: true })) },
        })),
    });
    const result = await f.director.drain(f.id);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    const gate = f.gateRun();
    assert.equal(gate.state, 'blocked');
    assert.equal(gate.gateArbitration.decision, 'confirm_defect');
    assert.equal(gate.blocker.current.code, 'repair_budget_exhausted', 'the blocker of the review refusal');
    assert.match(gate.error.message, /подтвердил дефект: The wording breaks the documented contract/);
    const blocker = result.blockers.find(row => row.gateId);
    assert.equal(blocker.code, 'repair_budget_exhausted');
    assert.equal(blocker.arbitration.decision, 'confirm_defect');
    assert.equal(blocker.arbitration.client, 'claude-code');
    assert.notEqual(f.repo.snapshot(f.id).project.status, 'accepted');
    assert.equal(f.calls.arbiter.length, 1);
    // The next drain reports the blocked gate Run; a direct resume reuses the recorded decision.
    const again = await f.director.drain(f.id);
    assert.equal(again.status, 'blocked');
    const resumed = await runEpicGate({
      engine: f.engine,
      run: gate,
      arbitration: { profile: twoProviders(), now: Date.now() },
    });
    assert.equal(resumed.state, 'blocked');
    assert.equal(f.calls.arbiter.length, 1, 'one arbitration per gate Run');
    assert.deepEqual(resumed.gateArbitration, gate.gateArbitration);
  },
);

test('split_needed blocks the gate with gate_split_needed and the work for extend', { timeout: 300000 }, async t => {
  const work = [{ title: 'Persist scores', description: 'Add a storage module', writePaths: ['storage/**'] }];
  const f = await fixture(t, {
    arbiter: schema =>
      arbiterAnswer(schema, value => ({
        ...value,
        decision: 'split_needed',
        rationale: 'The defect needs storage outside the covered tasks.',
        evidence: { ...value.evidence, findings: value.evidence.findings.map(row => ({ ...row, confirmed: true })) },
        splitWork: work,
      })),
  });
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(result.code, 'gate_split_needed');
  const blocker = result.blockers.find(row => row.gateId);
  assert.equal(blocker.code, 'gate_split_needed');
  assert.deepEqual(blocker.splitWork, work);
  const gate = f.gateRun();
  assert.equal(gate.state, 'blocked');
  assert.equal(gate.error.code, 'gate_split_needed');
  assert.deepEqual(gate.gateArbitration.splitWork, work);
});

test('Invalid arbiter output is confirm_defect: the gate blocks', { timeout: 300000 }, async t => {
  const f = await fixture(t, { arbiter: () => ({ decision: 'confirm_pass', rationale: 'Trust me' }) });
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  const gate = f.gateRun();
  assert.equal(gate.state, 'blocked');
  assert.equal(gate.gateArbitration.decision, 'confirm_defect');
  assert.equal(gate.gateArbitration.invalid, 'invalid_output');
  assert.equal(gate.gateArbitration.evidence, null);
  assert.notEqual(f.repo.snapshot(f.id).project.status, 'accepted');
  assert.equal(f.calls.arbiter.length, 1);
});

test(
  'A red deterministic check never reaches the arbiter: failed smoke or failed tests',
  { timeout: 300000 },
  async t => {
    await t.test('smoke', async t => {
      const f = await fixture(t, { smoke: [{ command: process.execPath, args: ['smoke.mjs'] }] });
      const result = await f.director.drain(f.id);
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.equal(f.calls.arbiter.length, 0);
      assert.equal(f.gateRun().gateArbitration, undefined);
      assert.equal(f.gateRun().error.code, 'smoke_failed');
    });
    await t.test('tests', async t => {
      const f = await fixture(t, {
        tasks: [task('alpha'), task('beta')],
        failTogether: ['alpha.txt', 'beta.txt'],
      });
      const result = await f.director.drain(f.id);
      assert.equal(result.status, 'blocked', JSON.stringify(result));
      assert.equal(f.calls.arbiter.length, 0);
      assert.equal(f.gateRun().gateArbitration, undefined);
      assert.equal(f.gateRun().review, null, 'the checks failed before any review');
    });
  },
);

test(
  'Without a profile or with one subscription the arbiter is never called; a two-provider profile arbitrates the retry',
  { timeout: 300000 },
  async t => {
    const f = await fixture(t, { profile: null });
    const first = await f.director.drain(f.id);
    assert.equal(first.status, 'blocked', JSON.stringify(first));
    assert.equal(first.blockers.find(row => row.gateId).code, 'repair_budget_exhausted');
    assert.equal(f.calls.arbiter.length, 0, 'no profile');
    assert.equal(f.gateRun().gateArbitration, undefined);
    f.repo.setProfile(f.id, profileOf(subscription('gpt', 'codex', 'gpt-6.1-sol')));
    const second = await f.director.drain(f.id, { retryFailed: true });
    assert.equal(second.status, 'blocked', JSON.stringify(second));
    assert.equal(f.calls.arbiter.length, 0, 'one subscription');
    assert.equal(f.repo.snapshot(f.id).gates.length, 2);
    f.repo.setProfile(f.id, twoProviders());
    const third = await f.director.drain(f.id, { retryFailed: true });
    assert.equal(third.status, 'accepted', JSON.stringify(third));
    assert.equal(f.calls.arbiter.length, 1);
    assert.equal(f.gateRun().gateArbitration.decision, 'confirm_pass');
  },
);

test('A substituted arbitration headSha is never accepted', { timeout: 300000 }, async t => {
  let tampered = 0;
  const f = await fixture(t, {
    wrapRepo: (repo, store) => ({
      ...repo,
      apply: async command => {
        const action = command.action;
        if (action.op === 'transition' && action.to === 'accepted' && !tampered++) {
          const runId = action.evidence[0].runId;
          const run = store.getRun(runId);
          store.updateRun(runId, { gateArbitration: { ...run.gateArbitration, headSha: sha('f') } });
        }
        return repo.apply(command);
      },
    }),
  });
  const result = await f.director.drain(f.id);
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(tampered > 0, true, 'the acceptance was attempted with the substituted record');
  assert.equal(f.calls.arbiter.length, 1);
  const snapshot = f.repo.snapshot(f.id);
  assert.notEqual(snapshot.project.status, 'accepted');
  assert.deepEqual(
    snapshot.tasks.map(row => row.status),
    ['integrated'],
    'nothing was accepted on the substituted head',
  );
  assert.equal(f.gateRun().state, 'blocked');
});

// --- round 2 -------------------------------------------------------------------------------------

test('R2 an interrupted arbiter session repeats once, only on the same head and review receipt', () => {
  const review = { passed: false, headSha: sha('b'), sessionId: 'review-2', findings: [] };
  const started = { status: 'started', headSha: sha('b'), reviewHash: reviewReceiptHash(review), attempts: 1 };
  assert.equal(ARBITER_MAX_ATTEMPTS, 2);
  assert.equal(arbiterRetryAllowed(started, sha('b'), review), true);
  assert.equal(arbiterRetryAllowed({ ...started, attempts: 2 }, sha('b'), review), false, 'one repeat only');
  assert.equal(arbiterRetryAllowed(started, sha('d'), review), false, 'another reviewed head');
  assert.equal(arbiterRetryAllowed(started, sha('b'), { ...review, sessionId: 'review-3' }), false, 'another review');
  assert.equal(arbiterRetryAllowed({ ...started, status: 'decided' }, sha('b'), review), false, 'decided');
  assert.equal(arbiterRetryAllowed(undefined, sha('b'), review), false);
});

const quota = () => Object.assign(new Error('Subscription limit reached'), { code: 'quota' });

test(
  'R1 saved receipts are checked like the Director before the arbiter: a deleted or substituted log or a stale diffHash blocks with the receipt code',
  { timeout: 600000 },
  async t => {
    const f = await fixture(t, { profile: null });
    const first = await f.director.drain(f.id);
    assert.equal(first.status, 'blocked', JSON.stringify(first));
    assert.equal(f.calls.arbiter.length, 0);
    const original = f.gateRun();
    const arbitration = { profile: twoProviders(), now: Date.now() };
    const resume = () => runEpicGate({ engine: f.engine, run: original.id, arbitration });
    const row = original.checks.results[0];
    const text = await readFile(row.outputPath, 'utf8');

    // 1. The log of a passed check is gone.
    await rm(row.outputPath, { force: true });
    let run = await resume();
    assert.equal(run.state, 'blocked');
    assert.equal(run.error.code, 'evidence_integrity');
    assert.equal(run.blocker.current.code, 'evidence_integrity');
    assert.equal(f.calls.arbiter.length, 0, 'no arbiter on a missing log');
    assert.equal(run.gateArbitration, undefined);
    await writeFile(row.outputPath, text, { mode: 0o600 });

    // 2. Another intact log stands in for the passed one.
    const log = JSON.parse(text);
    const forged = await f.engine.persistEvidence(
      f.store.getRun(original.id),
      'check',
      { ...log.value, exitCode: 1 },
      { headSha: original.checks.headSha },
    );
    const results = original.checks.results.map((item, index) =>
      index ? item : { ...item, outputPath: forged.path, outputHash: forged.sha256 },
    );
    f.store.updateRun(original.id, { checks: { ...original.checks, results } });
    run = await resume();
    assert.equal(run.state, 'blocked');
    assert.equal(run.error.code, 'project_proof_invalid');
    assert.equal(f.calls.arbiter.length, 0, 'no arbiter on a substituted log');
    f.store.updateRun(original.id, { checks: original.checks });

    // 3. The review receipt names another diff than the gate's current one.
    f.store.updateRun(original.id, { review: { ...original.review, diffHash: 'e'.repeat(64) } });
    run = await resume();
    assert.equal(run.state, 'blocked');
    assert.equal(run.error.code, 'project_review_stale');
    assert.equal(f.calls.arbiter.length, 0, 'no arbiter on a stale diffHash');
    f.store.updateRun(original.id, { review: original.review });

    // With the receipts intact again the same Run is arbitrated, and the Director accepts it.
    run = await resume();
    assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
    assert.equal(f.calls.arbiter.length, 1);
    assert.equal(run.gateArbitration.status, 'decided');
    const accepted = await f.director.drain(f.id);
    assert.equal(accepted.status, 'accepted', JSON.stringify(accepted));
  },
);

test(
  'R2 the start of an arbitration is recorded first; an interrupted session repeats once and then the drain accepts',
  { timeout: 300000 },
  async t => {
    let call = 0;
    const f = await fixture(t, {
      arbiter: schema => {
        if (++call === 1) throw quota();
        return arbiterAnswer(schema);
      },
    });
    const first = await f.director.drain(f.id);
    assert.notEqual(first.status, 'accepted', JSON.stringify(first));
    const interrupted = f.gateRun();
    assert.equal(interrupted.state, 'waiting_limits');
    assert.equal(interrupted.gateArbitration.status, 'started');
    assert.equal(interrupted.gateArbitration.attempts, 1);
    assert.equal(interrupted.gateArbitration.headSha, interrupted.review.headSha);
    assert.equal(interrupted.gateArbitration.reviewHash, reviewReceiptHash(interrupted.review));
    assert.equal(interrupted.gateArbitration.decision, undefined);
    const second = await f.director.drain(f.id);
    assert.equal(second.status, 'accepted', JSON.stringify(second));
    assert.equal(f.calls.arbiter.length, 2, 'one repeat after the interruption');
    const gate = f.gateRun();
    assert.equal(gate.gateArbitration.status, 'decided');
    assert.equal(gate.gateArbitration.decision, 'confirm_pass');
    assert.equal(gate.gateArbitration.attempts, 2);
  },
);

test(
  'R2 a second interruption ends the arbitration: confirm_defect with arbiter_retry_exhausted and no third session',
  { timeout: 300000 },
  async t => {
    const f = await fixture(t, {
      arbiter: () => {
        throw quota();
      },
    });
    await f.director.drain(f.id);
    const runId = f.gateRun().id;
    assert.equal(f.gateRun().state, 'waiting_limits');
    const arbitration = { profile: twoProviders(), now: Date.now() };
    let run = await runEpicGate({ engine: f.engine, run: runId, arbitration });
    assert.equal(run.state, 'waiting_limits');
    assert.equal(run.gateArbitration.status, 'started');
    assert.equal(run.gateArbitration.attempts, 2);
    assert.equal(f.calls.arbiter.length, 2);
    run = await runEpicGate({ engine: f.engine, run: runId, arbitration });
    assert.equal(run.state, 'blocked');
    assert.equal(f.calls.arbiter.length, 2, 'no third session');
    assert.equal(run.gateArbitration.status, 'decided');
    assert.equal(run.gateArbitration.decision, 'confirm_defect');
    assert.equal(run.gateArbitration.invalid, 'arbiter_retry_exhausted');
    assert.match(run.error.message, /arbiter_retry_exhausted/);
    const blocked = await f.director.drain(f.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockers.find(row => row.gateId).arbitration.invalid, 'arbiter_retry_exhausted');
    assert.equal(f.calls.arbiter.length, 2);
  },
);
