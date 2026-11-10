import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATION_EVENT,
  deliveryOperations,
  deploymentStatus,
  operationIntent,
  operationOutcome,
  uncertainOperations,
} from '../runtime/delivery-operations.mjs';
import { buildProgress } from '../runtime/progress.mjs';
import { recordBlocker } from '../runtime/watchdog.mjs';

/** A context that records events the way the delivery context and the Store do. */
function journal() {
  const events = [];
  let time = 1000;
  return { events, event: async (type, data) => void events.push({ type, data, time: time++ }) };
}
const state = events => Object.fromEntries(deliveryOperations(events).map(item => [item.operation, item.status]));

test('An intent without an outcome is uncertain; a read-back settles it one way or the other', async () => {
  const ctx = journal();
  assert.deepEqual(deliveryOperations(ctx.events), []);
  await operationIntent(ctx, 'merge', { pr: 7, head: 'a'.repeat(40) });
  assert.deepEqual(ctx.events[0], {
    type: OPERATION_EVENT,
    data: { pr: 7, head: 'a'.repeat(40), operation: 'merge', phase: 'intent' },
    time: 1000,
  });
  assert.deepEqual(uncertainOperations(ctx.events), ['merge']);
  assert.deepEqual(deliveryOperations(ctx.events), [
    {
      operation: 'merge',
      status: 'uncertain',
      attempts: 1,
      intentAt: 1000,
      outcomeAt: null,
      details: { pr: 7, head: 'a'.repeat(40) },
    },
  ]);
  await operationOutcome(ctx, 'merge', 'reconciled', { pr: 7, mergeCommit: 'b'.repeat(40) });
  assert.deepEqual(uncertainOperations(ctx.events), []);
  assert.deepEqual(deliveryOperations(ctx.events), [
    {
      operation: 'merge',
      status: 'reconciled',
      attempts: 1,
      intentAt: 1000,
      outcomeAt: 1001,
      details: { pr: 7, head: 'a'.repeat(40), mergeCommit: 'b'.repeat(40) },
    },
  ]);
});

test('Each operation keeps its own latest state, in delivery order, and counts its attempts', async () => {
  const ctx = journal();
  await operationIntent(ctx, 'release', { tag: 'v1.2.3' });
  await operationIntent(ctx, 'pr');
  await operationOutcome(ctx, 'pr', 'confirmed', { pr: 7 });
  await operationIntent(ctx, 'merge', { pr: 7 });
  await operationOutcome(ctx, 'merge', 'absent', { pr: 7 });
  assert.deepEqual(state(ctx.events), { pr: 'confirmed', merge: 'absent', release: 'uncertain' });
  // An absent effect may be attempted again: that is a new intent, and it is uncertain until read back.
  await operationIntent(ctx, 'merge', { pr: 7 });
  assert.deepEqual(state(ctx.events), { pr: 'confirmed', merge: 'uncertain', release: 'uncertain' });
  assert.equal(deliveryOperations(ctx.events).find(item => item.operation === 'merge').attempts, 2);
  await operationOutcome(ctx, 'merge', 'confirmed', { pr: 7 });
  await operationOutcome(ctx, 'release', 'reconciled', { tag: 'v1.2.3' });
  assert.deepEqual(uncertainOperations(ctx.events), []);
  assert.deepEqual(
    deliveryOperations(ctx.events).map(item => item.operation),
    ['pr', 'merge', 'release'],
  );
});

test('Foreign events, unknown operations and invented outcomes change nothing', () => {
  const events = [
    { type: 'delivery.merged', data: { operation: 'merge', phase: 'outcome', status: 'confirmed' } },
    { type: OPERATION_EVENT, data: { operation: 'deploy', phase: 'intent' } },
    { type: OPERATION_EVENT, data: { operation: 'merge', phase: 'outcome', status: 'passed' } },
    { type: OPERATION_EVENT, data: null },
    null,
  ];
  assert.deepEqual(deliveryOperations(events), []);
  assert.deepEqual(deliveryOperations(undefined), []);
  // An outcome recorded by reconciliation alone (the intent belonged to a lost process) still counts.
  assert.deepEqual(
    deliveryOperations([
      { type: OPERATION_EVENT, data: { operation: 'merge', phase: 'outcome', status: 'reconciled' } },
    ]),
    [{ operation: 'merge', status: 'reconciled', attempts: 0, intentAt: null, outcomeAt: null, details: {} }],
  );
});

test('Deployment is never reported as passed: not configured, or configured but not run', () => {
  assert.deepEqual(deploymentStatus({ commands: { deploy: [] } }), { status: 'not_configured', passed: null });
  assert.deepEqual(deploymentStatus({}), { status: 'not_configured', passed: null });
  assert.deepEqual(deploymentStatus({ commands: { deploy: [{ command: 'npm', args: ['run', 'deploy'] }] } }), {
    status: 'not_run',
    reason: 'no_deployment_adapter',
    passed: null,
  });
});

test('The recovery summary names an uncertain remote operation and the deployment status', () => {
  const deliveryState = [
    { operation: 'pr', status: 'confirmed' },
    { operation: 'merge', status: 'uncertain' },
  ];
  const summary = buildProgress({
    id: 'run-1',
    state: 'blocked',
    nodes: {},
    deliveryOperations: deliveryState,
    deployment: { status: 'not_configured', passed: null },
    blocker: recordBlocker(undefined, {
      code: 'timeout',
      message: 'gh pr merge timed out',
      scope: 'run',
      at: '2026-11-10T10:00:00.000Z',
      reasons: ['delivery_uncertain'],
    }),
  });
  assert.match(summary, /Delivery operations: pr confirmed; merge uncertain \(read back before retry\)/);
  assert.match(summary, /Deployment: not_configured/);
  assert.match(summary, /- Hypothesis: A remote delivery operation was started and not confirmed/);
});

test('A later read-back does not turn an effect this run confirmed into a reconciled one', async () => {
  const ctx = journal();
  await operationIntent(ctx, 'merge', { pr: 7 });
  await operationOutcome(ctx, 'merge', 'confirmed', { pr: 7, mergeCommit: 'b'.repeat(40) });
  await operationOutcome(ctx, 'merge', 'reconciled', { pr: 7, mergeCommit: 'b'.repeat(40) });
  assert.deepEqual(state(ctx.events), { merge: 'confirmed' });
  assert.equal(deliveryOperations(ctx.events)[0].outcomeAt, 1001, 'the confirming read-back is the one recorded');
  // A new attempt is a new intent; what settles it is recorded as it is.
  await operationIntent(ctx, 'merge', { pr: 7 });
  await operationOutcome(ctx, 'merge', 'reconciled', { pr: 7 });
  assert.deepEqual(state(ctx.events), { merge: 'reconciled' });
});

test('An outcome that cannot be written is swallowed; an intent that cannot be written is not', async () => {
  const broken = {
    event: async () => {
      throw new Error('database is locked');
    },
  };
  await operationOutcome(broken, 'merge', 'confirmed');
  await assert.rejects(operationIntent(broken, 'merge'), /database is locked/);
});
