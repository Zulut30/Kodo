import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from '../runtime/config.mjs';
import { runUIVerification } from '../runtime/ui-verification.mjs';
import { runSecurityChecks } from '../runtime/security-gates.mjs';
import { git, task, metrics, fixture } from './helpers/mode-engine-fixture.mjs';

test('Engine strict source fence rejects hidden bytes at check reuse commands gates and review', async t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree'])
    await t.test(flag, async t => {
      const fx = await fixture(t),
        log = path.join(fx.root, 'actual-commands.jsonl');
      const markers = Object.fromEntries(['test', 'build'].map(kind => [kind, path.join(fx.root, `${kind}-mutation`)]));
      for (const [file, kind] of [
        ['verify.mjs', 'test'],
        ['build.mjs', 'build'],
      ]) {
        const source = await readFile(path.join(fx.project, file), 'utf8');
        await writeFile(
          path.join(fx.project, file),
          source +
            `
import { appendFileSync, existsSync } from 'node:fs';
process.on('exit', exitCode => appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind:${JSON.stringify(kind)},exitCode}) + '\\n'));
if (existsSync(${JSON.stringify(markers[kind])})) appendFileSync(new URL('./value.mjs', import.meta.url), '// hidden command mutation\\n');
`,
        );
      }
      git(fx.project, 'add', '.');
      git(fx.project, 'commit', '-m', 'Observe source fence command exits');
      const created = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
      const result = await fx.engine.run(created.id);
      assert.equal(result.state, 'succeeded', result.error?.message);
      const baseline = fx.store.getRun(created.id),
        headSha = git(baseline.cwd, 'rev-parse', 'HEAD');
      assert.equal(baseline.checks.complete, true);
      assert.equal(baseline.checks.headSha, headSha);
      const commands = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.deepEqual(await commands(), [
        { kind: 'test', exitCode: 0 },
        { kind: 'build', exitCode: 0 },
      ]);
      for (const row of baseline.checks.results) {
        const bytes = await readFile(row.outputPath),
          evidence = JSON.parse(bytes);
        assert.equal(evidence.headSha, headSha);
        assert.equal(evidence.kind, 'check');
        assert.equal(evidence.value.kind, row.kind);
        assert.equal(evidence.value.exitCode, 0);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), row.outputHash);
      }
      const file = path.join(baseline.cwd, 'value.mjs'),
        original = await readFile(file, 'utf8');
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      git(baseline.cwd, 'update-index', flag, '--', 'value.mjs');
      const originalGates = { ...fx.engine.gates },
        originalProvider = fx.provider.runSession;
      const originalPersist = fx.engine.persistEvidence.bind(fx.engine);
      const scenarios = [
        'receipt reuse',
        'test mutation',
        'build mutation',
        'gate before',
        'ui gate mutation',
        'security gate mutation',
        'review before',
        'review mutation',
        'clean control',
      ];
      for (const scenario of scenarios)
        await t.test(scenario, async t => {
          await writeFile(file, original);
          await writeFile(log, '');
          for (const marker of Object.values(markers)) await rm(marker, { force: true });
          const run = structuredClone(baseline);
          fx.engine.gates = { ...originalGates };
          fx.provider.runSession = originalProvider;
          fx.engine.persistEvidence = originalPersist;
          let uiCalls = 0,
            securityCalls = 0,
            reviewCalls = 0;
          const mutate = () => writeFile(file, original + `// hidden ${scenario}\n`);
          if (scenario === 'receipt reuse' || scenario === 'gate before') await mutate();
          if (scenario === 'test mutation' || scenario === 'build mutation') {
            run.checks = null;
            await writeFile(markers[scenario.split(' ')[0]], 'mutate');
          }
          if (scenario.includes('gate')) {
            run.config.uiVerification.enabled = true;
            run.config.security.enabled = true;
            fx.engine.gates.runUIVerification = async ({ headSha }) => {
              uiCalls++;
              if (scenario === 'ui gate mutation') await mutate();
              return { headSha, status: 'passed', passed: true };
            };
            fx.engine.gates.runSecurityChecks = async ({ headSha }) => {
              securityCalls++;
              if (scenario === 'security gate mutation') await mutate();
              return { headSha, status: 'passed', passed: true };
            };
            for (const name of ['isCurrentUIReceipt', 'isCurrentSecurityReceipt'])
              fx.engine.gates[name] = (receipt, { headSha }) =>
                receipt?.headSha === headSha && receipt.status === 'passed' && receipt.passed === true;
          }
          if (scenario === 'review before')
            fx.engine.persistEvidence = async (...args) => {
              const receipt = await originalPersist(...args);
              if (args[1] === 'review') await mutate();
              return receipt;
            };
          fx.provider.runSession = async request => {
            const response = await originalProvider(request);
            if (request.schema.properties.passed) {
              reviewCalls++;
              if (scenario === 'review mutation') await mutate();
            }
            return response;
          };
          fx.engine.save(run);
          const porcelain = () => {
            const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
              cwd: run.cwd,
              encoding: 'utf8',
              windowsHide: true,
            });
            assert.equal(r.status, 0, r.stderr);
            return r.stdout;
          };
          const statusBefore = porcelain();
          assert.equal(statusBefore, '');
          const beforeEvents = fx.store.events(run.id).at(-1).seq;
          let error;
          try {
            if (scenario.includes('gate')) await fx.engine.verificationGates(run);
            else if (scenario.startsWith('review') || scenario === 'clean control') await fx.engine.verify(run);
            else await fx.engine.checks(run);
          } catch (caught) {
            error = caught;
          }
          const saved = fx.store.getRun(run.id),
            observed = await readFile(file),
            actualCommands = await commands();
          const statusAfter = porcelain(),
            actualHead = git(run.cwd, 'rev-parse', 'HEAD');
          const reused = fx.store.events(run.id, beforeEvents).filter(row => row.type === 'checks_reused').length;
          t.diagnostic(
            JSON.stringify({
              flag,
              scenario,
              statusBefore,
              statusAfter,
              headSha,
              actualHead,
              committedHash: hash(original),
              observedHash: hash(observed),
              actualCommands,
              reused,
              uiCalls,
              securityCalls,
              reviewCalls,
              errorCode: error?.code ?? null,
              errorMessage: error?.message ?? null,
              persistedChecksComplete: saved.checks?.complete,
              persistedCheckResults: saved.checks?.results.map(row => ({
                kind: row.kind,
                exitCode: row.exitCode,
                outputHash: row.outputHash,
              })),
              persistedReviewPassed: saved.review?.passed ?? null,
              persistedUI: saved.uiVerification?.status ?? null,
              persistedSecurity: saved.securityChecks?.status ?? null,
            }),
          );
          assert.equal(statusAfter, '');
          assert.equal(actualHead, headSha);
          assert.equal(hash(observed) === hash(original), scenario === 'clean control');
          assert.deepEqual(
            actualCommands,
            scenario === 'test mutation'
              ? [{ kind: 'test', exitCode: 0 }]
              : scenario === 'build mutation'
                ? [
                    { kind: 'test', exitCode: 0 },
                    { kind: 'build', exitCode: 0 },
                  ]
                : [],
          );
          if (scenario === 'clean control') {
            assert.equal(error, undefined);
            assert.equal(reused, 1);
            assert.equal(reviewCalls, 1);
            assert.equal(saved.checks.complete, true);
            assert.equal(saved.review.passed, true);
          } else {
            assert.ok(error, 'hidden bytes must not be accepted by the actual Engine boundary');
            if (!scenario.startsWith('review')) assert.equal(error.code, 'dirty_worktree');
            if (scenario === 'receipt reuse') {
              assert.equal(reused, 0);
              assert.deepEqual(saved.checks, baseline.checks);
            }
            if (scenario.endsWith('mutation') && ['test', 'build'].includes(scenario.split(' ')[0])) {
              assert.equal(saved.checks.complete, false);
              assert.equal(saved.checks.results.length, scenario === 'test mutation' ? 0 : 1);
            }
            if (scenario.includes('gate') || scenario.startsWith('review')) {
              assert.equal(saved.uiVerification, null);
              assert.equal(saved.securityChecks, null);
              assert.equal(saved.review, null);
            }
            if (scenario === 'gate before') {
              assert.equal(uiCalls, 0);
              assert.equal(securityCalls, 0);
            }
            if (scenario === 'ui gate mutation') {
              assert.equal(uiCalls, 1);
              assert.equal(securityCalls, 0);
            }
            if (scenario === 'security gate mutation') {
              assert.equal(uiCalls, 1);
              assert.equal(securityCalls, 1);
            }
            if (scenario.startsWith('review')) assert.equal(reviewCalls, scenario === 'review before' ? 0 : 1);
          }
        });
    });
});

test('Quick retains configured UI and security gates and missing tools block delivery without escalation', async t => {
  const fx = await fixture(t, {
    config: {
      uiVerification: {
        enabled: true,
        autoInstall: false,
        cases: [
          {
            id: 'button',
            tool: 'browser-harness',
            url: 'http://127.0.0.1:1',
            assertions: [{ selector: 'button', text: 'Ready' }],
          },
        ],
      },
      security: { enabled: true, autoInstall: false, tools: ['gitleaks'] },
    },
  });
  fx.engine.gates.runUIVerification = request =>
    runUIVerification({ ...request, toolHome: path.join(fx.root, 'missing-tools') });
  fx.engine.gates.runSecurityChecks = request =>
    runSecurityChecks({ ...request, toolHome: path.join(fx.root, 'missing-tools') });
  const run = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const result = await fx.engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.equal(result.executionMode.selected, 'quick');
  assert.equal(result.uiVerification.passed, false);
  assert.equal(result.securityChecks.passed, false);
  assert.equal(result.uiVerification.headSha, result.checks.headSha);
  assert.equal(result.securityChecks.headSha, result.checks.headSha);
  assert.equal(result.securityChecks.tools[0].reason, 'tool_missing');
  assert.equal(fx.calls.includes('review'), false);
  assert.equal(fx.calls.includes('research'), false);
  assert.equal(fx.store.events(run.id).filter(e => e.type === 'model_escalated').length, 0);
});

test('Execution mode config accepts only public modes and rejects invalid mode before provider startup', async t => {
  const fx = await fixture(t);
  for (const value of ['quick', 'standard', 'deep']) {
    await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ executionMode: value }));
    assert.equal((await readConfig(fx.project)).executionMode, value);
  }
  for (const value of ['auto', 'QUICK', null, 3]) {
    await writeFile(path.join(fx.project, 'kodo.config.json'), JSON.stringify({ executionMode: value }));
    await assert.rejects(readConfig(fx.project), /mode|режим/i);
  }
  await writeFile(path.join(fx.project, 'kodo.config.json'), '{}');
  await assert.rejects(fx.engine.create('Task', { project: fx.project, mode: 'invalid' }), /mode|режим/i);
});

test('Top-level benchmark parser runs before project provider and SQLite startup', () => {
  const result = spawnSync(process.execPath, ['cli/index.mjs', 'benchmark', 'report'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, KODO_HOME: 'Z:\\missing\\private' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires one PATH/);
  assert.doesNotMatch(result.stderr, /SQLite|credential|подпис|Неизвестн/);
});

test('Rewriting identical untracked bytes with a new timestamp stops at no progress before the repair cap', async t => {
  const fx = await fixture(t, {
    config: { executionMode: 'deep', repairRounds: 4, researchBudget: 0 },
    plan: () => ({
      summary: 'One scoped deliverable',
      tasks: [{ ...task('fix'), writePaths: ['value.mjs', 'notes.txt'] }],
    }),
  });
  const original = fx.provider.runSession;
  let attempts = 0,
    previousTimestamp;
  fx.provider.runSession = async request => {
    if (request.schema.properties.tasks || request.schema.properties.passed) return original(request);
    attempts++;
    const file = path.join(request.cwd, 'notes.txt');
    await writeFile(file, 'Same unfinished work\n');
    await utimes(file, 1700000000 + attempts, 1700000000 + attempts);
    const timestamp = (await stat(file)).mtimeMs;
    if (previousTimestamp !== undefined)
      assert.notEqual(timestamp, previousTimestamp, 'the witness changes metadata but preserves bytes');
    previousTimestamp = timestamp;
    return {
      metrics: metrics(),
      output: { complete: false, summary: 'Still missing the same requirement', checks: [] },
    };
  };
  const run = await fx.engine.create('Set value to one', { project: fx.project });
  const blocked = await fx.engine.run(run.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.nodes.fix.stopped, 'no_progress');
  assert.equal(blocked.nodes.fix.attempt, 2);
  assert.equal(blocked.controllerAssessment.reason, 'no_progress');
  assert.equal(attempts, 2);
  assert.equal(fx.calls.includes('research'), false);
  assert.equal((await fx.engine.run(run.id)).state, 'blocked');
  assert.equal(attempts, 2, 'ordinary resume cannot reset a stopped cycle');
});

test('Review quota recovery cannot reuse a previous enabled UI pass after observations fail', async t => {
  const fx = await fixture(t, {
    config: {
      uiVerification: {
        enabled: true,
        autoInstall: false,
        cases: [
          {
            id: 'ready',
            tool: 'browser-harness',
            url: 'http://127.0.0.1:1',
            assertions: [{ selector: 'body', text: 'Ready' }],
          },
        ],
      },
    },
  });
  let observations = 0,
    quota = true;
  fx.engine.gates.runUIVerification = request =>
    runUIVerification({
      ...request,
      caseRunner: async () => {
        observations++;
        return {
          schemaVersion: 1,
          status: 'completed',
          observations: [{ exists: true, count: 1, text: observations === 1 ? 'Ready' : 'Broken', value: null }],
        };
      },
    });
  const original = fx.provider.runSession;
  fx.provider.runSession = async request => {
    const response = await original(request);
    if (request.schema.properties.passed && quota) {
      quota = false;
      throw Object.assign(new Error('Review quota fixture'), { code: 'quota', metrics: metrics() });
    }
    return response;
  };
  const created = await fx.engine.create('Set value to one', { project: fx.project, mode: 'quick' });
  const waiting = await fx.engine.run(created.id);
  assert.equal(waiting.state, 'waiting_limits');
  assert.equal(waiting.uiVerification.passed, true);
  const checkedHead = waiting.checks.headSha;
  const resumed = await fx.engine.run(created.id);
  assert.equal(resumed.state, 'blocked');
  assert.equal(resumed.checks.headSha, checkedHead);
  assert.equal(resumed.uiVerification.headSha, checkedHead);
  assert.equal(observations, 2);
  assert.equal(resumed.uiVerification.passed, false);
  assert.equal(resumed.uiVerification.cases[0].assertions[0].passed, false);
  assert.equal(resumed.review, null);
  assert.equal(
    fx.calls.filter(call => call === 'review').length,
    1,
    'newly failed UI evidence must prevent another review success',
  );
});
