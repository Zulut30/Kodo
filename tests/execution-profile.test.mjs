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
