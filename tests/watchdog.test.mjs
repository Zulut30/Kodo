import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgress } from '../runtime/progress.mjs';
import {
  normalizeWatchdogConfig,
  observeRun,
  recordBlocker,
  resetWatchdog,
  resolveBlocker,
  unchanged,
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
  // A round that breaks a check and the next that repairs it only return to the best state already reached.
  const broken = observation({ checks: { results: [{ exitCode: 1 }, { exitCode: 1 }] }, behavior: null });
  let ping = watchdogStep(undefined, { key: 'p0', observation: same, limit: 2 });
  ping = watchdogStep(ping, { key: 'p1', observation: broken, limit: 2 });
  ping = watchdogStep(ping, { key: 'p2', observation: same, limit: 2 });
  assert.deepEqual([ping.stalled, ping.stopped?.reason], [2, 'no_verified_progress']);
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
  blockers = recordBlocker(blockers, { ...failure, at: at(1), headSha: 'a'.repeat(40), message: 'other wording' });
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
  // The resumed run stops for the same reason on the same commit: one blocker, not another copy.
  const again = recordBlocker(blockers, { code: 'quota', message: 'limit reached', scope: 'run', at: at(4) });
  assert.deepEqual(
    [again.current.occurrences, again.current.firstSeen, again.current.lastSeen, again.current.lastMessage],
    [2, at(2), at(4), 'limit reached'],
  );
  assert.deepEqual(
    again.history.map(item => item.code),
    ['no_progress'],
    'the resumed entry left the history',
  );
  assert.equal(again.current.endedAt, undefined);
  // A run-level stop has no place or reason of its own: another text is another failure.
  const other = recordBlocker(blockers, { code: 'quota', message: 'a different failure', scope: 'run', at: at(4) });
  assert.deepEqual(
    [other.current.occurrences, other.current.message, other.history.length],
    [1, 'a different failure', 2],
  );
  // A stop with its own place and reason keeps its identity when only the wording changes, and shows the latest wording.
  let worded = recordBlocker(undefined, { code: 'no_progress', message: 'first text', scope: 'node-a', at: at(0) });
  worded = recordBlocker(worded, { code: 'no_progress', message: 'second text', scope: 'node-a', at: at(1) });
  assert.deepEqual(
    [worded.current.occurrences, worded.current.message, worded.current.lastMessage],
    [2, 'first text', 'second text'],
  );
  assert.match(
    buildProgress({ id: 'run-1', state: 'blocked', nodes: {}, blocker: worded }),
    /Current blocker: no_progress \[node-a\] second text/,
  );
  const moved = recordBlocker(blockers, {
    code: 'quota',
    message: 'limit',
    scope: 'run',
    at: at(4),
    headSha: 'b'.repeat(40),
  });
  assert.deepEqual([moved.current.occurrences, moved.history.length], [1, 2], 'another commit is another blocker');
  assert.equal(resolveBlocker(undefined, { at: at(4), outcome: 'resumed' }), undefined);
  let long = undefined;
  for (let index = 0; index < 30; index++)
    long = recordBlocker(long, { code: 'blocked', message: 'failure', scope: `node-${index}`, at: at(5) });
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
  const cancelled = buildProgress({
    ...run,
    state: 'cancelled',
    blocker,
    error: { code: 'cancelled', message: 'stopped by user' },
  });
  assert.match(cancelled, /Stopped: cancelled stopped by user/);
  // A run cancelled before it ever stopped has no blocker record yet.
  assert.match(
    buildProgress({ ...run, state: 'cancelled', error: { code: 'cancelled', message: 'stopped by user' } }),
    /Stopped: cancelled stopped by user/,
  );
  assert.doesNotMatch(cancelled, /previous attempt/);
  assert.doesNotMatch(
    buildProgress({ ...run, blocker, watchdog: { stalled: 0 } }),
    /Watchdog:/,
    'no limit, no counter line',
  );
  assert.match(
    buildProgress({ ...run, blocker, watchdog: { stalled: 1 }, config: { watchdog: { stalledRounds: 2 } } }),
    /Watchdog: 1 round\(s\) without verified progress\n/,
  );
});

test('A node is unchanged only when its staged tree equals the base; any difference is work', async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kodo-unchanged-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const files = {
    'math.mjs': 'export function add(a, b) {\n  // sum\n  return a + b;\n}\n',
    'spaced.mjs': 'export const first = 1;\n\n\nexport const second = 2;\n',
    'cli.js': "\n#!/usr/bin/env node\nconsole.log('ok');\n",
    // One byte outside UTF-8: read as text, both versions would look the same.
    'label.js': Buffer.from("export const label = 'café';\n", 'latin1'),
  };
  const write = (name, content) => writeFileSync(path.join(cwd, name), content);
  for (const [name, content] of Object.entries(files)) write(name, content);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Unchanged Test');
  git('config', 'user.email', 'unchanged@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-m', 'Base');
  const base = git('rev-parse', 'HEAD');
  const reset = () => {
    git('reset', '-q', '--hard', base);
    git('clean', '-qfd');
  };
  assert.equal(await unchanged(cwd, base), true, 'no change at all');
  write('math.mjs', files['math.mjs']);
  assert.equal(await unchanged(cwd, base), true, 'a file rewritten with the same content');
  const edit = (name, change) => () => write(name, change(files[name]));
  for (const [label, change] of [
    ['behaviour', edit('math.mjs', text => text.replace('a + b', 'a - b'))],
    ['a comment a security scanner reads', edit('math.mjs', text => text.replace('// sum', '// nosemgrep: audit'))],
    ['a comment that only explains', edit('math.mjs', text => `// analysis: looks correct\n${text}`)],
    ['an empty line a formatter reports', edit('spaced.mjs', text => text.replace('\n\n\n', '\n\n'))],
    ['an empty line before a hashbang', edit('cli.js', text => text.slice(1))],
    ['a byte outside UTF-8', () => write('label.js', Buffer.from("export const label = 'cafè';\n", 'latin1'))],
    ['trailing spaces', edit('math.mjs', text => text.replace('a + b;', 'a + b;   '))],
    ['line ends', edit('math.mjs', text => text.replaceAll('\n', '\r\n'))],
    ['a new empty file', () => write('__init__.py', '')],
    ['a rename', () => git('mv', 'math.mjs', 'sum.mjs')],
    ['a deleted file', () => git('rm', '-q', 'cli.js')],
    [
      // Both ways of recording an executable bit: the index where Git ignores file modes, the file elsewhere.
      'a mode change',
      () => {
        git('update-index', '--chmod=+x', 'math.mjs');
        chmodSync(path.join(cwd, 'math.mjs'), 0o755);
      },
    ],
  ]) {
    change();
    assert.equal(await unchanged(cwd, base), false, label);
    reset();
  }
  assert.equal(await unchanged(cwd, '0'.repeat(40)), false, 'a base that cannot be read is not "unchanged"');
});

test('The watchdog block is optional, bounded and strict about keys', () => {
  assert.deepEqual(normalizeWatchdogConfig(), { stalledRounds: null, rejectUnchanged: false });
  assert.deepEqual(normalizeWatchdogConfig({ stalledRounds: 2, rejectUnchanged: true }), {
    stalledRounds: 2,
    rejectUnchanged: true,
  });
  assert.equal(normalizeWatchdogConfig({ stalledRounds: null }).stalledRounds, null);
  for (const bad of [
    [],
    'on',
    { stalledRounds: 0 },
    { stalledRounds: 6 },
    { stalledRounds: 1.5 },
    { rejectUnchanged: 1 },
    { rejectCosmetic: true },
    { rounds: 2 },
  ])
    assert.throws(
      () => normalizeWatchdogConfig(bad),
      error => error.code === 'configuration',
      JSON.stringify(bad),
    );
});
