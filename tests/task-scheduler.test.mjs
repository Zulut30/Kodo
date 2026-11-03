import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadyQueue } from '../runtime/task-scheduler.mjs';

const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
const task = (id, dependsOn = []) => ({ id, dependsOn });
function fixture(tasks, overrides = {}) {
  const integrated = new Set(), events = [];
  return { integrated, events, options: {
    tasks, limit: 2, isIntegrated: task => integrated.has(task.id),
    prepare: async task => { events.push(`prepare:${task.id}`); },
    compatible: () => true,
    execute: async task => { events.push(`execute:${task.id}`); },
    integrate: async task => { events.push(`integrate:${task.id}`); integrated.add(task.id); },
    ...overrides
  } };
}

test('Ready queue starts a newly integrated dependent before unrelated execution finishes', { timeout: 10000 }, async () => {
  const slowStarted = deferred(), downstreamStarted = deferred(), releaseSlow = deferred();
  const fx = fixture([task('A'), task('B'), task('C', ['A'])], {
    execute: async task => {
      if (task.id === 'A') await slowStarted.promise;
      if (task.id === 'B') { slowStarted.resolve(); await releaseSlow.promise; }
      if (task.id === 'C') { assert.ok(fx.integrated.has('A')); downstreamStarted.resolve(); }
    }
  });
  const running = runReadyQueue(fx.options);
  try { await downstreamStarted.promise; assert.equal(fx.integrated.has('B'), false); }
  finally { releaseSlow.resolve(); }
  await running;
  assert.deepEqual([...fx.integrated].sort(), ['A', 'B', 'C']);
});

test('Ready queue drains successful siblings after execute failure and preserves the original typed error', async () => {
  const started = deferred(), failed = deferred(), release = deferred();
  const original = Object.assign(new Error('quota on A'), { code: 'quota' });
  let finished = false;
  const fx = fixture([task('A'), task('B'), task('never')], {
    execute: async task => {
      if (task.id === 'A') { await started.promise; failed.resolve(); throw original; }
      if (task.id === 'B') { started.resolve(); await release.promise; }
      assert.notEqual(task.id, 'never');
    }
  });
  const running = runReadyQueue(fx.options);
  const rejection = assert.rejects(running, error => error === original).then(() => { finished = true; });
  await failed.promise; await turn(); assert.equal(finished, false);
  release.resolve(); await rejection;
  assert.deepEqual([...fx.integrated], ['B']);
  assert.equal(fx.events.includes('prepare:never'), false);
});

test('Ready queue drains executions when asynchronous preparation fails', async () => {
  const started = deferred(), failed = deferred(), release = deferred();
  const original = Object.assign(new Error('routing rejected'), { code: 'auth' });
  let finished = false;
  const fx = fixture([task('B'), task('A'), task('never')], {
    prepare: async task => { if (task.id === 'A') { await started.promise; failed.resolve(); throw original; } },
    execute: async task => { assert.equal(task.id, 'B'); started.resolve(); await release.promise; }
  });
  const rejection = assert.rejects(runReadyQueue(fx.options), error => error === original).then(() => { finished = true; });
  await failed.promise; await turn(); assert.equal(finished, false);
  release.resolve(); await rejection;
  assert.deepEqual([...fx.integrated], ['B']);
});

test('Ready queue processes a completion while unrelated preparation is still pending', { timeout: 10000 }, async () => {
  const preparing = deferred(), integrated = deferred(), releasePrepare = deferred();
  const fx = fixture([task('A'), task('B')], {
    prepare: async task => { if (task.id === 'B') { preparing.resolve(); await releasePrepare.promise; } },
    execute: async task => { if (task.id === 'A') await preparing.promise; },
    integrate: async task => { fx.integrated.add(task.id); if (task.id === 'A') integrated.resolve(); }
  });
  const running = runReadyQueue(fx.options);
  try { await integrated.promise; assert.deepEqual([...fx.integrated], ['A']); }
  finally { releasePrepare.resolve(); }
  await running;
});

test('Ready queue admits a dependent while an unrelated route is still preparing', { timeout: 10000 }, async () => {
  const preparing = deferred(), downstream = deferred(), release = deferred();
  const fx = fixture([task('A'), task('B'), task('C', ['A'])], {
    prepare: async task => { if (task.id === 'B') { preparing.resolve(); await release.promise; } },
    execute: async task => { if (task.id === 'A') await preparing.promise; if (task.id === 'C') downstream.resolve(); }
  });
  const running = runReadyQueue(fx.options);
  try { await downstream.promise; assert.equal(fx.integrated.has('B'), false); }
  finally { release.resolve(); }
  await running;
});

test('Ready queue serializes successful integration and holds scopes until merge completes', async () => {
  const merging = deferred(), release = deferred();
  let mergeActive = 0;
  const starts = [];
  const fx = fixture([task('A'), task('B'), task('overlap')], {
    compatible: (task, active) => task.id !== 'overlap' || !active.some(other => other.id === 'A'),
    execute: async task => { starts.push(task.id); if (task.id === 'overlap') assert.ok(fx.integrated.has('A')); },
    integrate: async task => {
      assert.equal(++mergeActive, 1);
      if (task.id === 'A') { merging.resolve(); await release.promise; }
      fx.integrated.add(task.id); mergeActive--;
    }
  });
  const running = runReadyQueue(fx.options);
  await merging.promise; await turn();
  assert.equal(starts.includes('overlap'), false); assert.equal(fx.integrated.has('B'), false);
  release.resolve(); await running;
  assert.deepEqual([...fx.integrated], ['A', 'B', 'overlap']);
});

test('Ready queue drains work after a compatibility callback throws', async () => {
  const started = deferred(), rejected = deferred(), release = deferred();
  const original = Object.assign(new Error('scope check failed'), { code: 'scope_conflict' });
  let finished = false;
  const fx = fixture([task('A'), task('B')], {
    compatible: task => { if (task.id === 'B') { rejected.resolve(); throw original; } return true; },
    execute: async () => { started.resolve(); await release.promise; }
  });
  const rejection = assert.rejects(runReadyQueue(fx.options), error => error === original).then(() => { finished = true; });
  await started.promise; await rejected.promise; await turn(); assert.equal(finished, false);
  release.resolve(); await rejection; assert.deepEqual([...fx.integrated], ['A']);
});

test('Ready queue observes simultaneous synchronous execution failures without unhandled rejections', async () => {
  const bothStarted = deferred(), original = Object.assign(new Error('first error'), { code: 'auth' });
  let started = 0;
  const fx = fixture([task('A'), task('B'), task('never')], {
    execute: async task => {
      if (++started === 2) bothStarted.resolve();
      await bothStarted.promise;
      throw task.id === 'A' ? original : new Error('secondary error');
    }
  });
  await assert.rejects(runReadyQueue(fx.options), error => error === original);
  assert.equal(started, 2); assert.equal(fx.integrated.size, 0);
});

test('Ready queue pre-abort calls no routing execution or integration', async () => {
  const controller = new AbortController(); controller.abort();
  const fx = fixture([task('A')], { signal: controller.signal });
  await assert.rejects(runReadyQueue(fx.options), { code: 'cancelled' });
  assert.deepEqual(fx.events, []);
});

test('Ready queue preserves synchronous callback errors at each asynchronous boundary', async t => {
  for (const stage of ['prepare', 'execute', 'integrate']) await t.test(stage, async () => {
    const original = Object.assign(new Error(`${stage} rejected`), { code: 'unavailable' });
    const fx = fixture([task('A')], { [stage]: () => { throw original; } });
    await assert.rejects(runReadyQueue(fx.options), error => error === original);
    assert.equal(fx.integrated.size, 0);
  });
});

test('Ready queue abort drains an in-progress integration and does not start the next merge', async () => {
  const controller = new AbortController(), merging = deferred(), release = deferred();
  let finished = false;
  const merges = [];
  const fx = fixture([task('A'), task('B')], {
    signal: controller.signal,
    integrate: async task => { merges.push(task.id); merging.resolve(); await release.promise; fx.integrated.add(task.id); }
  });
  const rejection = assert.rejects(runReadyQueue(fx.options), { code: 'cancelled' }).then(() => { finished = true; });
  await merging.promise; controller.abort(); await turn(); assert.equal(finished, false);
  release.resolve(); await rejection;
  assert.deepEqual(merges, ['A']); assert.deepEqual([...fx.integrated], ['A']);
});

test('Ready queue serializes integration and leaves later completions untouched after a merge failure', async () => {
  const bothStarted = deferred(), firstMerge = deferred(), releaseMerge = deferred(), releaseB = deferred();
  const original = Object.assign(new Error('pending merge belongs to A'), { code: 'merge_state' });
  const merges = []; let executing = 0, finished = false;
  const fx = fixture([task('A'), task('B'), task('never')], {
    execute: async task => {
      if (++executing === 2) bothStarted.resolve();
      await bothStarted.promise;
      if (task.id === 'B') await releaseB.promise;
    },
    integrate: async task => { merges.push(task.id); firstMerge.resolve(); await releaseMerge.promise; throw original; }
  });
  const rejection = assert.rejects(runReadyQueue(fx.options), error => error === original).then(() => { finished = true; });
  await firstMerge.promise; releaseMerge.resolve(); await turn();
  assert.equal(finished, false); releaseB.resolve(); await rejection;
  assert.deepEqual(merges, ['A']); assert.equal(fx.events.includes('prepare:never'), false);
});

test('Ready queue preserves an execute error even when draining integration also fails', async () => {
  const started = deferred(), failed = deferred(), release = deferred();
  const original = Object.assign(new Error('quota'), { code: 'quota' });
  const fx = fixture([task('A'), task('B')], {
    execute: async task => {
      if (task.id === 'A') { await started.promise; failed.resolve(); throw original; }
      started.resolve(); await release.promise;
    },
    integrate: async () => { throw Object.assign(new Error('merge rejected'), { code: 'merge_state' }); }
  });
  const rejection = assert.rejects(runReadyQueue(fx.options), error => error === original);
  await failed.promise; await turn(); release.resolve(); await rejection;
});

test('Ready queue abort stops admission and drains both pending preparation and running execution', async () => {
  const controller = new AbortController(), preparing = deferred(), started = deferred(), releasePrepare = deferred(), releaseExecute = deferred();
  let finished = false;
  const executed = [], merged = [];
  const fx = fixture([task('B'), task('A'), task('never')], {
    signal: controller.signal,
    prepare: async task => { if (task.id === 'A') { preparing.resolve(); await releasePrepare.promise; } },
    execute: async task => { executed.push(task.id); started.resolve(); await releaseExecute.promise; },
    integrate: async task => { merged.push(task.id); }
  });
  const rejection = assert.rejects(runReadyQueue(fx.options), { code: 'cancelled' }).then(() => { finished = true; });
  await preparing.promise; await started.promise; controller.abort(); await turn(); assert.equal(finished, false);
  releaseExecute.resolve(); await turn(); assert.equal(finished, false);
  releasePrepare.resolve(); await rejection;
  assert.deepEqual(executed, ['B']); assert.deepEqual(merged, []);
});

test('Ready queue retries a bounded attempt after a no-op integration and prepares it once per attempt', async () => {
  let executions = 0;
  const fx = fixture([task('A'), task('C', ['A'])], {
    execute: async task => { if (task.id === 'A') executions++; else assert.equal(executions, 2); },
    integrate: async task => { if (task.id !== 'A' || executions === 2) fx.integrated.add(task.id); }
  });
  await runReadyQueue(fx.options);
  assert.equal(executions, 2);
  assert.deepEqual(fx.events, ['prepare:A', 'prepare:A', 'prepare:C']);
});

test('Ready queue caches incompatible prepared tasks and respects capacity and all active scopes', async () => {
  const release = deferred(), aStarted = deferred(), bStarted = deferred();
  const active = new Set(), starts = [], prepareCounts = {};
  const tasks = [task('A'), task('blocked'), task('B'), task('C')];
  const fx = fixture(tasks, {
    prepare: async task => { prepareCounts[task.id] = (prepareCounts[task.id] || 0) + 1; },
    compatible: (task, activeTasks) => !activeTasks.some(other => [task.id, other.id].includes('blocked')),
    execute: async task => {
      starts.push(task.id); active.add(task.id); assert.ok(active.size <= 2);
      if (task.id === 'A') { aStarted.resolve(); await release.promise; }
      if (task.id === 'B') { bStarted.resolve(); await release.promise; }
      if (task.id === 'blocked') assert.equal(active.size, 1);
      active.delete(task.id);
    }
  });
  const running = runReadyQueue(fx.options);
  await aStarted.promise; await bStarted.promise;
  assert.deepEqual(starts, ['A', 'B']); release.resolve(); await running;
  assert.deepEqual(prepareCounts, { A: 1, blocked: 1, B: 1, C: 1 });
});

test('Ready queue skips already integrated tasks using persisted state', async () => {
  const fx = fixture([task('saved'), task('next', ['saved'])]); fx.integrated.add('saved');
  await runReadyQueue(fx.options);
  assert.deepEqual(fx.events, ['prepare:next', 'execute:next', 'integrate:next']);
});

test('Ready queue validates empty plans invalid graphs invalid capacity and terminal incompatibility', async t => {
  await runReadyQueue(fixture([]).options);
  for (const [label, tasks, limit] of [
    ['duplicate IDs', [task('A'), task('A')], 2],
    ['missing dependency', [task('A', ['missing'])], 2],
    ['cycle', [task('A', ['B']), task('B', ['A'])], 2],
    ['zero capacity', [task('A')], 0],
    ['fractional capacity', [task('A')], 1.5]
  ]) await t.test(label, async () => {
    const fx = fixture(tasks, { limit });
    await assert.rejects(runReadyQueue(fx.options), { code: 'invalid_plan' });
    assert.deepEqual(fx.events, []);
  });
  await assert.rejects(runReadyQueue(fixture([task('A')], { compatible: () => false }).options), { code: 'scheduler_deadlock' });
});
