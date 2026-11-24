import { assertDirectorSafe } from './project-contracts.mjs';

export const MAX_WORKERS = 64;
const check = ok => {
  if (!ok) throw Object.assign(new Error('Invalid execution profile'), { code: 'project_profile_invalid' });
};
function keys(value, allowed) {
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every(key => allowed.includes(key)),
  );
}
const label = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_WORKERS;
const unique = rows => new Set(rows.map(row => row.id)).size === rows.length;
const total = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0);
function instant(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  // Comparing the wall time also rejects normalized dates such as February 30.
  const wall = match[1] + '.' + (match[2] ?? '').padEnd(3, '0').slice(0, 3) + 'Z';
  return new Date(wall).toISOString() === wall;
}
export function validateExecutionProfile(profile, options = { knownValues: [] }) {
  assertDirectorSafe(profile, options);
  keys(profile, ['schemaVersion', 'subscriptions', 'machines']);
  check(profile.schemaVersion === undefined || profile.schemaVersion === 1);
  for (const rows of [profile.subscriptions, profile.machines])
    check(Array.isArray(rows) && rows.length >= 1 && rows.length <= MAX_WORKERS);
  for (const sub of profile.subscriptions) {
    keys(sub, ['id', 'provider', 'model', 'slots', 'tier', 'cooldownUntil']);
    check(
      [sub.id, sub.provider, sub.model].every(label) &&
        count(sub.slots) &&
        ['heavy', 'standard', 'fast'].includes(sub.tier),
    );
    check(sub.cooldownUntil == null || instant(sub.cooldownUntil));
  }
  for (const machine of profile.machines) {
    keys(machine, ['id', 'kind', 'maxWorkers', 'maxHeavyBuilds', 'environmentId']);
    check(
      label(machine.id) &&
        ['local', 't3-env', 'ssh'].includes(machine.kind) &&
        count(machine.maxWorkers) &&
        Number.isSafeInteger(machine.maxHeavyBuilds) &&
        machine.maxHeavyBuilds >= 1,
    );
    check(machine.environmentId === undefined || label(machine.environmentId));
  }
  check(
    unique(profile.subscriptions) &&
      unique(profile.machines) &&
      total(profile.subscriptions, 'slots') <= MAX_WORKERS &&
      total(profile.machines, 'maxWorkers') <= MAX_WORKERS,
  );
  return structuredClone({ ...profile, schemaVersion: 1 });
}

const active = (profile, now) => profile.subscriptions.filter(sub => !(Date.parse(sub.cooldownUntil) > now));
export function waveCapacity(profile, now) {
  return profile ? Math.min(total(active(profile, now), 'slots'), total(profile.machines, 'maxWorkers')) : 5;
}

// Existing attempts keep their original placement. Unassigned attempts (e.g. native runs)
// still consume global capacity; a paused pool receives no new assignments.
export function assignWorker(profile, now, occupied, tiers) {
  if (!profile) return null;
  const free = (rows, kind, key) =>
    rows.filter(row => occupied.filter(p => p?.[kind]?.id === row.id).length < row[key]);
  const pools = free(active(profile, now), 'subscription', 'slots');
  const pool = tiers.map(tier => pools.find(p => p.tier === tier)).find(Boolean);
  const host = free(profile.machines, 'machine', 'maxWorkers')[0];
  if (!pool || !host) return null;
  return {
    subscription: { id: pool.id, provider: pool.provider, model: pool.model, tier: pool.tier },
    machine: { id: host.id, kind: host.kind, ...(host.environmentId && { environmentId: host.environmentId }) },
  };
}
export const waveHorizon = limit => Math.min(128, Math.max(24, limit * 2));
