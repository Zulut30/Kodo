import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgress } from '../runtime/progress.mjs';
import {
  cosmeticOnly,
  normalizeWatchdogConfig,
  observeRun,
  recordBlocker,
  resetWatchdog,
  resolveBlocker,
  verifiedProgress,
  watchdogStep,
} from '../runtime/watchdog.mjs';

const failing = (extra = {}) => ({
  nodes: { a: { status: 'integrated' }, b: { status: 'running' } },
  checks: { results: [{ exitCode: 0 }, { exitCode: 1 }] },
  behavior: { passed: true, findings: [] },
  uiVerification: { passed: null },
  securityChecks: null,
  review: null,
  ...extra,
});
const observation = extra => observeRun(failing(extra));

test('Only accepted facts are progress; a new commit, session or different output is not', () => {
  const before = observation();
  assert.deepEqual(before, {
    integrated: 1,
    checksPassed: 1,
    behaviorPassed: true,
    behaviorFindings: 0,
    gatesPassed: 0,
    reviewPassed: false,
    reviewFindings: null,
  });
  // The run moved its head, spent sessions and printed other errors: none of that is observed at all.
  const busy = observation({
    headSha: 'b'.repeat(40),
    sessionAttempts: Array(20).fill({}),
    error: { message: 'new text' },
  });
  assert.deepEqual(verifiedProgress(before, busy), { progressed: false, reasons: [] });
  const cases = [
    [{ nodes: { a: { status: 'integrated' }, b: { status: 'integrated' } } }, 'node_integrated'],
    [{ checks: { results: [{ exitCode: 0 }, { exitCode: 0 }] } }, 'check_passed'],
    [{ securityChecks: { passed: true } }, 'gate_passed'],
    [{ review: { passed: true, findings: [] } }, 'review_passed'],
  ];
  for (const [change, reason] of cases)
    assert.deepEqual(verifiedProgress(before, observation(change)).reasons, [reason], reason);
  const red = observation({ behavior: { passed: false, findings: [{}, {}] } });
  assert.deepEqual(verifiedProgress(red, observation({ behavior: { passed: false, findings: [{}] } })).reasons, [
    'behavior_findings_resolved',
  ]);
  assert.deepEqual(verifiedProgress(red, before).reasons, ['behavior_gate_passed', 'behavior_findings_resolved']);
  const reviewed = observation({ review: { passed: false, findings: [{}, {}, {}] } });
  assert.deepEqual(verifiedProgress(reviewed, observation({ review: { passed: false, findings: [{}] } })).reasons, [
    'review_findings_resolved',
  ]);
  assert.equal(verifiedProgress(before, reviewed).progressed, false, 'a first failed review is not progress');
});

test('The watchdog counts stalled rounds, stops at the limit and repeats a step harmlessly', () => {
  const same = observation();
  let state;
  for (const [key, stalled, stopped] of [
    ['verification:1:0', 0, false],
    ['verification:1:1', 1, false],
    ['verification:1:2', 2, true],
  ]) {
    state = watchdogStep(state, { key, observation: same, limit: 2 });
    assert.equal(state.stalled, stalled, key);
    assert.equal(Boolean(state.stopped), stopped, key);
    assert.equal(watchdogStep(state, { key, observation: same, limit: 2 }), state, 'the same key is a no-op');
  }
  assert.deepEqual(state.stopped, { reason: 'no_verified_progress', stalled: 2, limit: 2, key: 'verification:1:2' });
  assert.deepEqual(
    state.rounds.map(round => [round.key, round.progressed]),
    [
      ['verification:1:0', true],
      ['verification:1:1', false],
      ['verification:1:2', false],
    ],
  );
  // Verified progress resets the count; without a limit nothing ever stops.
  let moving = watchdogStep(undefined, { key: 'r0', observation: same, limit: 1 });
  moving = watchdogStep(moving, {
    key: 'r1',
    observation: observation({ securityChecks: { passed: true } }),
    limit: 1,
  });
  assert.deepEqual([moving.stalled, moving.stopped], [0, undefined]);
  let unlimited;
  for (let round = 0; round < 30; round++)
    unlimited = watchdogStep(unlimited, { key: `r${round}`, observation: same, limit: null });
  assert.deepEqual([unlimited.stalled, unlimited.stopped, unlimited.rounds.length], [29, undefined, 20]);
  // An explicit retry cycle counts again and keeps the history.
  const reset = resetWatchdog(state);
  assert.deepEqual([reset.stalled, reset.stopped, reset.rounds.length], [0, undefined, 3]);
  assert.equal(watchdogStep(reset, { key: 'verification:2:0', observation: same, limit: 2 }).stalled, 0);
  assert.equal(resetWatchdog(undefined), undefined);
});

test('The same blocker is counted, a different one moves the old into history, a resume makes it history', () => {
  const at = minute => `2026-11-10T10:0${minute}:00.000Z`;
  const failure = { code: 'no_progress', message: 'check failed: exit 1', scope: 'verification' };
  let blockers = recordBlocker(undefined, { ...failure, at: at(0), headSha: 'a'.repeat(40), reasons: ['regression'] });
  assert.equal(blockers.current.occurrences, 1);
  assert.deepEqual(blockers.history, []);
  assert.equal(blockers.current.hypotheses.length, 2, 'hypotheses come from the recorded facts');
  blockers = recordBlocker(blockers, { ...failure, at: at(1) });
  assert.deepEqual(
    [blockers.current.occurrences, blockers.current.firstSeen, blockers.current.lastSeen, blockers.history.length],
    [2, at(0), at(1), 0],
  );
  blockers = recordBlocker(blockers, {
    code: 'quota',
    message: 'limit reached',
    scope: 'run',
    at: at(2),
    evidence: [{ sha256: 'c'.repeat(64), kind: 'check', path: 'C:\\private\\state' }],
  });
  assert.deepEqual([blockers.current.code, blockers.current.occurrences], ['quota', 1]);
  assert.deepEqual(blockers.current.evidence, [{ sha256: 'c'.repeat(64), kind: 'check' }], 'no private path is kept');
  assert.deepEqual(
    blockers.history.map(item => [item.code, item.outcome, item.endedAt, item.occurrences]),
    [['no_progress', 'replaced', at(2), 2]],
  );
  blockers = resolveBlocker(blockers, { at: at(3), outcome: 'resumed' });
  assert.equal(blockers.current, null);
  assert.deepEqual(
    blockers.history.map(item => [item.code, item.outcome]),
    [
      ['no_progress', 'replaced'],
      ['quota', 'resumed'],
    ],
  );
  assert.equal(resolveBlocker(blockers, { at: at(4), outcome: 'succeeded' }), blockers, 'nothing current to resolve');
  assert.equal(resolveBlocker(undefined, { at: at(4), outcome: 'resumed' }), undefined);
  let long = undefined;
  for (let index = 0; index < 30; index++)
    long = recordBlocker(long, { code: 'blocked', message: `failure ${index}`, scope: 'run', at: at(5) });
  assert.equal(long.history.length, 20, 'history is bounded');
});

test('The recovery summary shows the current blocker and never presents an older error as current', () => {
  const run = { id: 'run-1', state: 'blocked', nodes: {}, error: { code: 'blocked', message: 'old failure text' } };
  assert.match(buildProgress(run), /Pending blocker: blocked old failure text/, 'runs saved before the watchdog');
  let blocker = recordBlocker(undefined, {
    code: 'no_verified_progress',
    message: 'check failed: exit 1',
    scope: 'verification',
    at: '2026-11-10T10:00:00.000Z',
    headSha: 'a'.repeat(40),
    evidence: [{ sha256: 'c'.repeat(64), kind: 'check' }],
  });
  const stopped = buildProgress({
    ...run,
    blocker,
    watchdog: { stalled: 2, stopped: { limit: 2 } },
  });
  assert.match(stopped, /Current blocker: no_verified_progress \[verification\] check failed: exit 1/);
  assert.match(stopped, /- Hypothesis: Several repair rounds changed no accepted criterion/);
  assert.match(stopped, /Evidence: check c{64}/);
  assert.match(stopped, /Watchdog: 2 round\(s\) without verified progress; stopped at limit 2/);
  assert.doesNotMatch(stopped, /Pending blocker|Last error/);
  blocker = resolveBlocker(blocker, { at: '2026-11-10T11:00:00.000Z', outcome: 'resumed' });
  const resumed = buildProgress({ ...run, state: 'testing', blocker });
  assert.doesNotMatch(resumed, /Current blocker|Pending blocker/);
  assert.match(resumed, /Last error \(previous attempt, not the current blocker\): blocked old failure text/);
  assert.match(
    resumed,
    /Earlier blockers: 1\n- resumed 2026-11-10T11:00:00.000Z: no_verified_progress \[verification\]/,
  );
});

test('A change of comments and whitespace only, or no change, is cosmetic; code is not', async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kodo-cosmetic-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const source = 'export function add(a, b) {\n  return a + b;\n}\n';
  writeFileSync(path.join(cwd, 'math.mjs'), source);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Cosmetic Test');
  git('config', 'user.email', 'cosmetic@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-m', 'Base');
  const base = git('rev-parse', 'HEAD');
  const reset = () => {
    git('reset', '-q', '--hard', base);
    git('clean', '-qfd');
  };
  assert.equal(await cosmeticOnly(cwd, base), true, 'no change at all');
  for (const [name, text, expected] of [
    ['comment', `// analysis: the function looks correct\n${source}`, true],
    ['block comment and blank lines', `/*\n * notes\n */\n\n${source}\n\n`, true],
    ['indentation', source.replace('  return', '      return'), true],
    ['behaviour', source.replace('a + b', 'a - b'), false],
    ['comment plus behaviour', `// fix\n${source.replace('a + b', 'b + a')}`, false],
  ]) {
    writeFileSync(path.join(cwd, 'math.mjs'), text);
    assert.equal(await cosmeticOnly(cwd, base), expected, name);
    reset();
  }
  writeFileSync(path.join(cwd, 'new.mjs'), 'export const value = 1;\n');
  assert.equal(await cosmeticOnly(cwd, base), false, 'a new file with code');
  reset();
  writeFileSync(path.join(cwd, 'notes.mjs'), '// only a note\n');
  assert.equal(await cosmeticOnly(cwd, base), true, 'a new file with comments only');
  reset();
  writeFileSync(path.join(cwd, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  assert.equal(await cosmeticOnly(cwd, base), false, 'a binary change is not judged cosmetic');
});

test('The watchdog block is optional, bounded and strict about keys', () => {
  assert.deepEqual(normalizeWatchdogConfig(), { stalledRounds: null, rejectCosmetic: false });
  assert.deepEqual(normalizeWatchdogConfig({ stalledRounds: 2, rejectCosmetic: true }), {
    stalledRounds: 2,
    rejectCosmetic: true,
  });
  assert.equal(normalizeWatchdogConfig({ stalledRounds: null }).stalledRounds, null);
  for (const bad of [
    [],
    'on',
    { stalledRounds: 0 },
    { stalledRounds: 6 },
    { stalledRounds: 1.5 },
    { rejectCosmetic: 1 },
    { rounds: 2 },
  ])
    assert.throws(
      () => normalizeWatchdogConfig(bad),
      error => error.code === 'configuration',
      JSON.stringify(bad),
    );
});
