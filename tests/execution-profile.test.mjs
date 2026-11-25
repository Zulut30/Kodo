import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExecutionProfile, waveCapacity } from '../runtime/execution-profile.mjs';
test('Profile v1 bounds independent resource totals and rejects malformed or secret data', () => {
  const profile = {
    schemaVersion: 1,
    subscriptions: [{ id: 'a', provider: 'codex', model: 'gpt', slots: 64, tier: 'fast' }],
    machines: [{ id: 'host', kind: 'local', maxWorkers: 64, maxHeavyBuilds: 1 }],
  };
  assert.deepEqual(validateExecutionProfile(profile), profile);
  for (const change of [
    p => (p.token = 'secret'),
    p => (p.machines[0].other = true),
    p => (p.subscriptions[0].slots = 0),
    p => p.subscriptions.push({ ...p.subscriptions[0], id: 'b', slots: 1 }),
    p => (p.machines[0].maxWorkers = 65),
    p => (p.machines[0].maxHeavyBuilds = 65),
    p => (p.subscriptions[0].cooldownUntil = '2025-02-30T00:00:00Z'),
  ]) {
    const copy = structuredClone(profile);
    change(copy);
    assert.throws(() => validateExecutionProfile(copy), { code: 'project_profile_invalid' });
  }
  assert.throws(() => validateExecutionProfile(profile, { knownValues: ['gpt'] }), { code: 'project_unsafe' });
  profile.subscriptions[0].cooldownUntil = '2026-01-01T01:00:00+01:00';
  assert.deepEqual(validateExecutionProfile(profile), profile);
  assert.equal(waveCapacity(profile, Date.parse('2025-01-01')), 0);
  assert.equal(waveCapacity(profile, Date.parse('2026-01-01')), 64);
});

test('A1 capacity counts each active pool, each machine and unassigned attempts', async () => {
  const { freeWorkerSlots } = await import('../runtime/execution-profile.mjs');
  const profile = {
    subscriptions: [
      { id: 'a', slots: 1 },
      { id: 'b', slots: 4 },
    ],
    machines: [
      { id: 'x', maxWorkers: 4 },
      { id: 'y', maxWorkers: 4 },
    ],
  };
  const placement = (sub, machine) => ({ subscription: { id: sub }, machine: { id: machine } });
  const busy = Array.from({ length: 4 }, () => placement('a', 'x'));
  assert.equal(freeWorkerSlots(profile, 0, busy), 4);
  profile.subscriptions[0].cooldownUntil = '2099-01-01T00:00:00Z';
  assert.equal(freeWorkerSlots(profile, 0, busy), 4);
  assert.equal(freeWorkerSlots(profile, 0, [...busy, undefined, placement('removed', 'removed')]), 2);
  const smallerMachine = {
    subscriptions: [{ id: 'a', slots: 8 }],
    machines: [
      { id: 'x', maxWorkers: 1 },
      { id: 'y', maxWorkers: 4 },
    ],
  };
  assert.equal(freeWorkerSlots(smallerMachine, 0, busy), 4, 'shrinking the occupied machine leaves four slots on y');
});

const fourSlots = {
  subscriptions: [{ id: 'sub', provider: 'codex', model: 'gpt', tier: 'fast', slots: 4 }],
  machines: [{ id: 'pc', kind: 'local', maxWorkers: 4, maxHeavyBuilds: 1 }],
};
const placement = (sub, machine) => ({ subscription: { id: sub }, machine: { id: machine } });
test('B2 replacement on just one axis charges each attempt once', async () => {
  const { freeWorkerSlots } = await import('../runtime/execution-profile.mjs');
  for (const row of [placement('old', 'pc'), placement('sub', 'old')]) {
    assert.equal(freeWorkerSlots(fourSlots, 0, [row, row]), 2);
  }
});
test('B4 unassigned and removed placements count against the host batch', async () => {
  const { chargedBriefs } = await import('../runtime/execution-profile.mjs');
  assert.equal(chargedBriefs(fourSlots, 0, [{}, placement('old', 'pc'), placement('sub', 'old')]), 3);
});
test('B5 direct worker assignment respects unknown occupancy', async () => {
  const { assignWorker } = await import('../runtime/execution-profile.mjs');
  assert.equal(assignWorker(fourSlots, 0, Array(4).fill(undefined), ['fast']), null);
});

test('16A validates transport settings and excludes unavailable machines', async () => {
  const { assignWorker } = await import('../runtime/execution-profile.mjs');
  const profile = structuredClone(fourSlots);
  Object.assign(profile.machines[0], { kind: 'ssh', gitRemote: 'team/workers.eu', trustedBuilds: false, down: true });
  assert.deepEqual(validateExecutionProfile(profile).machines, profile.machines);
  assert.equal(assignWorker(profile, 0, [], ['fast']), null);
  for (const patch of [{ trustedBuilds: 1 }, { down: 'yes' }, { gitRemote: '--upload-pack' }, { gitRemote: 'a:b' }]) {
    assert.throws(() => validateExecutionProfile({ ...profile, machines: [{ ...profile.machines[0], ...patch }] }), {
      code: 'project_profile_invalid',
    });
  }
});
