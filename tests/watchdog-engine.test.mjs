import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engine } from '../runtime/engine.mjs';
import { fixture, fakeServices, node } from './helpers/engine-fixture.mjs';

const done = { sessionId: 'worker', output: { summary: 'done', checks: [], complete: true } };
const isRepair = call => /Repair confirmed failures/.test(call.prompt);
// Fails every time with different output, like an agent that keeps printing new analysis.
const noisyFailure =
  "console.error('analysis ' + process.hrtime.bigint() + ': still investigating'); process.exit(1);\n";
const progress = run => readFile(path.join(run.artifacts, 'progress.md'), 'utf8');

/** One developer node; every repair appends a comment, so the head moves and the diff grows. */
async function stalling(t, config, { onRepair } = {}) {
  // Deep keeps the full repair budget of five, so the watchdog limit is what stops the run.
  const fx = await fixture(t, {
    config: { executionMode: 'deep', repairRounds: 5, researchBudget: 0, ...config },
    testScript: noisyFailure,
  });
  const services = fakeServices({
    plan: { summary: 'One change', tasks: [node('change', 'developer', ['src/**'])] },
    onWorker: async call => {
      if (!isRepair(call)) await writeFile(path.join(call.cwd, 'src/value.mjs'), 'export const value = 2;\n');
      else {
        await onRepair?.(call);
        await appendFile(path.join(call.cwd, 'src/value.mjs'), `// analysis round ${Date.now()}-${Math.random()}\n`);
      }
      return done;
    },
  });
  const store = fx.openStore(),
    engine = new Engine({ store, ...services });
  const run = await engine.create('Change the value', { project: fx.project });
  const repairs = () => services.calls.worker.filter(isRepair).length;
  return { fx, services, engine, store, run, repairs };
}

test('Rounds that only produce new output and commits stop at the stalled limit, with a diagnosable blocker', async t => {
  const { engine, run, repairs } = await stalling(t, { watchdog: { stalledRounds: 2 } });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.equal(repairs(), 2, 'two repairs without verified progress, not the whole budget of five');
  assert.equal(result.verification.stopped, 'no_verified_progress');
  assert.deepEqual(
    [result.watchdog.stalled, result.watchdog.stopped.limit, result.watchdog.rounds.map(round => round.progressed)],
    [2, 2, [true, false, false]],
  );
  const blocker = result.blocker.current;
  assert.deepEqual([blocker.code, blocker.scope, blocker.occurrences], ['no_verified_progress', 'verification', 1]);
  assert.match(blocker.message, /Проверка test не пройдена/);
  assert.ok(blocker.hypotheses.some(text => /changed no accepted criterion/.test(text)));
  assert.deepEqual(
    blocker.evidence.map(item => item.kind),
    ['check'],
    'the failing check output is referenced for the next session',
  );
  assert.equal(blocker.headSha, result.headSha);
  const summary = await progress(result);
  assert.match(summary, /Current blocker: no_verified_progress \[verification\]/);
  assert.match(summary, /Watchdog: 2 round\(s\) without verified progress; stopped at limit 2/);

  // A plain resume cannot spend more: the stop is durable. Stopping again for the same reason
  // on the same commit continues the same blocker instead of adding a copy to the history.
  const again = await engine.run(run.id);
  assert.equal(again.state, 'blocked');
  assert.equal(repairs(), 2);
  assert.deepEqual(
    [again.blocker.current.code, again.blocker.current.scope, again.blocker.current.occurrences],
    ['no_verified_progress', 'verification', 2],
  );
  assert.equal(again.blocker.current.firstSeen, blocker.firstSeen);
  assert.match(again.blocker.current.message, /Проверка test не пройдена/, 'the original failure text is kept');
  assert.deepEqual(again.blocker.history, []);
  assert.match(await progress(again), /Seen 2 time\(s\)/);
});

test('Without a configured limit the existing repair budget alone decides', async t => {
  const { engine, run, repairs } = await stalling(t, { repairRounds: 3 });
  const result = await engine.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.equal(repairs(), 2);
  assert.equal(result.verification.stopped, 'repair_budget_exhausted');
  assert.equal(result.watchdog.stopped, undefined);
  assert.equal(result.blocker.current.code, 'repair_budget_exhausted');
});

test('The stalled count survives a restart in the middle of the cycle', async t => {
  let interrupt = true;
  const { fx, services, engine, store, run, repairs } = await stalling(
    t,
    { watchdog: { stalledRounds: 2 } },
    {
      onRepair: () => {
        // The second repair is interrupted by the provider limit before it changes anything.
        if (interrupt && repairs() === 2) {
          interrupt = false;
          throw Object.assign(new Error('fixture quota'), { code: 'quota' });
        }
      },
    },
  );
  const paused = await engine.run(run.id);
  assert.deepEqual([paused.state, paused.watchdog.stalled], ['waiting_limits', 1]);
  assert.deepEqual([paused.blocker.current.code, paused.blocker.current.scope], ['quota', 'run']);
  fx.closeStore(store);

  const restarted = new Engine({ store: fx.openStore(), ...services });
  const result = await restarted.run(run.id);
  assert.equal(result.state, 'blocked');
  assert.deepEqual([result.watchdog.stalled, result.verification.stopped], [2, 'no_verified_progress']);
  assert.equal(repairs(), 3, 'the interrupted repair resumed once; no round was counted twice or forgotten');
  assert.deepEqual(
    result.blocker.history.map(item => [item.code, item.outcome]),
    [['quota', 'resumed']],
    'the quota pause is history, not the current blocker',
  );
  assert.equal(result.blocker.current.code, 'no_verified_progress');
});

test('A stalled node does not stop an independent one, and the blocker names the stalled node', async t => {
  const fx = await fixture(t, { config: { repairRounds: 2, researchBudget: 0 }, testScript: 'process.exit(0);\n' });
  const services = fakeServices({
    plan: {
      summary: 'Two independent files',
      tasks: [node('stuck', 'developer', ['out/stuck.txt']), node('free', 'developer', ['out/free.txt'])],
    },
    onWorker: async call => {
      const id = path.basename(call.cwd);
      if (id === 'stuck')
        return { sessionId: 'stuck', output: { summary: 'still analysing', checks: [], complete: false } };
      await mkdir(path.join(call.cwd, 'out'), { recursive: true });
      await writeFile(path.join(call.cwd, 'out/free.txt'), 'free\n');
      return done;
    },
  });
  const engine = new Engine({ store: fx.openStore(), ...services });
  const result = await engine.run((await engine.create('Two files', { project: fx.project })).id);
  assert.equal(result.state, 'blocked');
  assert.equal(result.nodes.free.status, 'integrated', 'the independent node finished and was integrated');
  assert.equal(result.nodes.stuck.status, 'blocked');
  assert.equal(result.blocker.current.scope, 'stuck');
  assert.match(result.blocker.current.code, /^(no_progress|repair_budget_exhausted)$/);
});

test('A cosmetic change cannot complete a code node when the watchdog rejects it', async t => {
  const cosmetic = async call =>
    appendFile(path.join(call.cwd, 'src/value.mjs'), '// reviewed: the value looks right\n');
  for (const [name, config, role, state] of [
    ['rejected', { watchdog: { rejectCosmetic: true } }, 'developer', 'blocked'],
    ['documentation may be comments', { watchdog: { rejectCosmetic: true } }, 'documenter', 'succeeded'],
    ['not rejected unless configured', {}, 'developer', 'succeeded'],
  ])
    await t.test(name, async subtest => {
      const fx = await fixture(subtest, {
        config: { repairRounds: 1, researchBudget: 0, ...config },
        testScript: 'process.exit(0);\n',
      });
      const services = fakeServices({
        plan: { summary: 'One change', tasks: [node('change', role, ['src/**'])] },
        onWorker: async call => {
          await cosmetic(call);
          return done;
        },
      });
      const engine = new Engine({ store: fx.openStore(), ...services });
      const result = await engine.run((await engine.create('Change the value', { project: fx.project })).id);
      assert.equal(result.state, state, result.error?.message);
      if (state === 'blocked') {
        assert.match(result.nodes.change.error, /Только косметические изменения/);
        assert.equal(services.calls.review.length, 0, 'nothing was accepted or reviewed');
        assert.equal(result.blocker.current.scope, 'change');
      } else assert.equal(result.blocker?.current ?? null, null);
    });
});

test('A real fix after an explicit retry cycle succeeds and leaves no current blocker', async t => {
  const fx = await fixture(t, {
    config: { repairRounds: 3, researchBudget: 0, watchdog: { stalledRounds: 1, rejectCosmetic: true } },
    testScript:
      "import { value } from './src/value.mjs';\nif (value !== 3) { console.error('value is ' + value + ' at ' + process.hrtime.bigint()); process.exit(1); }\n",
  });
  let fix = false;
  const services = fakeServices({
    plan: { summary: 'One change', tasks: [node('change', 'developer', ['src/**'])] },
    onWorker: async call => {
      const value = fix ? 3 : isRepair(call) ? 20 + services.calls.worker.length : 2;
      await writeFile(path.join(call.cwd, 'src/value.mjs'), `export const value = ${value};\n`);
      return done;
    },
  });
  const engine = new Engine({ store: fx.openStore(), ...services });
  const run = await engine.create('Set the value to three', { project: fx.project });
  const blocked = await engine.run(run.id);
  assert.deepEqual([blocked.state, blocked.verification.stopped], ['blocked', 'no_verified_progress']);
  fix = true;
  const result = await engine.run(run.id, { retryFailed: true });
  assert.equal(result.state, 'succeeded', result.error?.message);
  assert.equal(result.blocker.current, null);
  assert.deepEqual(
    result.blocker.history.map(item => item.outcome),
    ['resumed'],
  );
  assert.deepEqual([result.watchdog.stalled, result.watchdog.stopped], [0, undefined]);
  assert.doesNotMatch(await progress(result), /Current blocker|Pending blocker/);
});
