// Stage 15B: epic gates take an epic-level lease and independent epics gate concurrently;
// a gate that covers a milestone (or the project) stays exclusive to the gates of its epics.
// The director runs on an in-memory repository: installed gate Runs go straight to `runGate`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runPendingGates } from '../runtime/project-director-waves.mjs';

const projectId = randomUUID();
const complete = rows => ({ total: rows.length, returned: rows.length, complete: true });

// epics: [{ id, milestoneId, status?, busy? }]; every epic has one integrated task and one
// installed gate (containers from `chains`, default the epic alone) whose Run has not run yet. A
// `busy` epic still has its task running: it is open but not ready for a gate.
function memoryProject({ milestones, epics, chains = {}, leaseHeartbeatMs = 10000 }) {
  const tasks = epics.map(epic => ({
    id: `task-${epic.id}`,
    epicId: epic.id,
    status: epic.status === 'accepted' ? 'accepted' : epic.busy ? 'running' : 'integrated',
    dependsOn: [],
    writePaths: [`src/${epic.id}.mjs`],
  }));
  const gates = epics
    .filter(epic => epic.status !== 'accepted' && !epic.busy)
    .map((epic, index) => ({
      id: `gate-${epic.id}`,
      number: index + 1,
      containers: chains[epic.id] ?? [{ kind: 'epic', id: epic.id }],
      runId: `run-${epic.id}`,
      merges: [],
    }));
  const snapshot = {
    project: { projectId, status: 'running', paused: false, root: '/memory' },
    revision: 1,
    milestones: milestones.map(id => ({ id, status: 'running' })),
    epics: epics.map(({ busy, ...epic }) => ({ status: 'running', ...epic })),
    tasks,
    currentAttempts: [],
    gates,
  };
  snapshot.completeness = {
    milestones: complete(snapshot.milestones),
    epics: complete(snapshot.epics),
    tasks: complete(snapshot.tasks),
  };
  const runs = new Map(gates.map(gate => [gate.runId, { id: gate.runId, state: 'created' }]));
  const leases = new Map();
  const store = {
    getRun(id) {
      if (!runs.has(id)) throw new Error(`Запуск не найден: ${id}`);
      return structuredClone(runs.get(id));
    },
    updateRun(id, patch) {
      runs.set(id, { ...runs.get(id), ...patch });
      return structuredClone(runs.get(id));
    },
    acquireLease(name, owner, { limit = 1 } = {}) {
      const held = [...leases.values()].filter(row => row.name === name).length;
      if (held >= limit) return null;
      const token = randomUUID();
      leases.set(token, { name, owner });
      return token;
    },
    renewLease: token => leases.has(token),
    releaseLease: token => leases.delete(token),
  };
  const ctx = {
    repo: { snapshot: async () => structuredClone(snapshot), apply: async () => ({}) },
    engine: { leaseHeartbeatMs },
    store,
    contracts: { isWaveProject: () => true },
    clock: () => new Date().toISOString(),
  };
  return { ctx, store, leases, snapshot };
}

const blockedGate = run => ({ ...run, state: 'blocked', error: { code: 'gate_red', message: 'red' } });

test('Gates of two independent epics run at the same time', async () => {
  // e3's task still runs: e1 and e2 are not the last open epics of the project.
  const { ctx, leases } = memoryProject({
    milestones: ['m1', 'm2', 'm3'],
    epics: [
      { id: 'e1', milestoneId: 'm1' },
      { id: 'e2', milestoneId: 'm2' },
      { id: 'e3', milestoneId: 'm3', busy: true },
    ],
  });
  let open;
  const both = new Promise(resolve => (open = resolve));
  const failsafe = setTimeout(() => open(false), 2000);
  failsafe.unref();
  const running = new Set(),
    seen = [],
    overlapped = [];
  ctx.runGate = async ({ run }) => {
    running.add(run.id);
    seen.push([...leases.values()].map(row => row.name).sort());
    if (running.size === 2) {
      clearTimeout(failsafe);
      open(true);
    }
    overlapped.push(await both);
    running.delete(run.id);
    return blockedGate(run);
  };
  const out = await runPendingGates(ctx, { projectId });
  assert.deepEqual(overlapped, [true, true], 'the second gate started while the first one ran');
  assert.deepEqual(
    out.blocked.map(row => [row.kind, row.id, row.code]),
    [
      ['epic', 'e1', 'gate_red'],
      ['epic', 'e2', 'gate_red'],
    ],
  );
  assert.ok(
    seen.at(-1).includes(`project-gate:${projectId}:e1`) && seen.at(-1).includes(`project-gate:${projectId}:e2`),
    `each gate holds its own epic lease: ${JSON.stringify(seen)}`,
  );
  assert.equal(leases.size, 0, 'every gate lease is released');
});

test('The last open epics of one milestone never gate at the same time', async () => {
  const { ctx } = memoryProject({
    milestones: ['m'],
    epics: [
      { id: 'e1', milestoneId: 'm' },
      { id: 'e2', milestoneId: 'm' },
    ],
  });
  const events = [];
  ctx.runGate = async ({ run }) => {
    events.push(`start ${run.id}`);
    await new Promise(resolve => setImmediate(resolve));
    events.push(`end ${run.id}`);
    return blockedGate(run);
  };
  await runPendingGates(ctx, { projectId });
  assert.deepEqual(events, ['start run-e1', 'end run-e1', 'start run-e2', 'end run-e2']);
});

test('An epic gate held elsewhere is reported, and a milestone gate waits for its epics', async () => {
  // e1 is accepted, its gate is still finishing in another process (its epic lease is held);
  // e2's gate covers the milestone; e3 in another milestone is independent.
  const { ctx, store, leases } = memoryProject({
    milestones: ['m1', 'm2'],
    epics: [
      { id: 'e1', milestoneId: 'm1', status: 'accepted' },
      { id: 'e2', milestoneId: 'm1' },
      { id: 'e3', milestoneId: 'm2' },
    ],
    chains: {
      e2: [
        { kind: 'epic', id: 'e2' },
        { kind: 'milestone', id: 'm1' },
      ],
    },
  });
  const elsewhere = store.acquireLease(`project-gate:${projectId}:e1`, 'other-process');
  const ran = [];
  ctx.runGate = async ({ run }) => {
    ran.push(run.id);
    return blockedGate(run);
  };
  const out = await runPendingGates(ctx, { projectId });
  assert.deepEqual(ran, ['run-e3'], 'only the independent epic gates');
  assert.deepEqual(out.blocked.map(row => [row.kind, row.id, row.code]).sort(), [
    ['epic', 'e2', 'project_gate_running'],
    ['epic', 'e3', 'gate_red'],
  ]);
  assert.deepEqual(
    [...leases.values()].map(row => row.name),
    [`project-gate:${projectId}:e1`],
    'only the foreign lease remains',
  );
  store.releaseLease(elsewhere);
});

test('The last open epics of the project never gate together, in any number of milestones', async () => {
  const { ctx } = memoryProject({
    milestones: ['m1', 'm2'],
    epics: [
      { id: 'e1', milestoneId: 'm1' },
      { id: 'e2', milestoneId: 'm2' },
    ],
  });
  const events = [];
  ctx.runGate = async ({ run }) => {
    events.push(`start ${run.id}`);
    await new Promise(resolve => setImmediate(resolve));
    events.push(`end ${run.id}`);
    return blockedGate(run);
  };
  const out = await runPendingGates(ctx, { projectId });
  assert.deepEqual(events, ['start run-e1', 'end run-e1', 'start run-e2', 'end run-e2']);
  assert.ok(!out.blocked.some(row => row.code === 'project_gate_running'), JSON.stringify(out.blocked));
});

test('A gate whose epic lease is lost stops and never accepts', async () => {
  const { ctx, store, leases } = memoryProject({
    milestones: ['m1', 'm2'],
    epics: [
      { id: 'e1', milestoneId: 'm1' },
      { id: 'e2', milestoneId: 'm2', busy: true },
    ],
    leaseHeartbeatMs: 5,
  });
  const name = `project-gate:${projectId}:e1`;
  let other;
  ctx.runGate = async ({ run, signal }) => {
    // The TTL expired and another holder took the epic lease.
    for (const [token, row] of leases) if (row.name === name) leases.delete(token);
    other = store.acquireLease(name, 'other');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ...run, state: 'cancelled', error: { code: 'cancelled', message: 'lease lost' } };
  };
  const out = await runPendingGates(ctx, { projectId });
  assert.ok(other, 'the other holder got the lease');
  assert.deepEqual(
    out.blocked.map(row => row.code),
    ['cancelled', 'project_lease_lost'],
  );
  assert.deepEqual(out.accepted, []);
});

test('A gate whose epic lease is lost before it starts is reported, never a clean pass', async () => {
  const { ctx, store } = memoryProject({
    milestones: ['m1', 'm2'],
    epics: [
      { id: 'e1', milestoneId: 'm1' },
      { id: 'e2', milestoneId: 'm2', busy: true },
    ],
    leaseHeartbeatMs: 5,
  });
  // The epic lease expires right after it was taken: its first renewal finds no row.
  const name = `project-gate:${projectId}:e1`;
  let doomed = null,
    noticed;
  const seen = new Promise(resolve => (noticed = resolve));
  const acquire = store.acquireLease,
    renew = store.renewLease,
    snapshot = ctx.repo.snapshot;
  store.acquireLease = (lease, owner, options) => {
    const token = acquire(lease, owner, options);
    if (lease === name) doomed = token;
    return token;
  };
  store.renewLease = token => {
    if (token !== doomed) return renew(token);
    noticed();
    return false;
  };
  ctx.repo.snapshot = async id => {
    if (doomed) await seen;
    return snapshot(id);
  };
  ctx.runGate = async () => assert.fail('a gate without its lease never runs');
  const out = await runPendingGates(ctx, { projectId });
  assert.deepEqual(
    out.blocked.map(row => [row.code, row.kind, row.id]),
    [['project_lease_lost', 'epic', 'e1']],
  );
});

test('A pass that a pause stopped reports why, even when the pause is lifted afterwards', async () => {
  const project = memoryProject({
    milestones: ['m1', 'm2', 'm3'],
    epics: [
      { id: 'e1', milestoneId: 'm1' },
      { id: 'e2', milestoneId: 'm2' },
      { id: 'e3', milestoneId: 'm3', busy: true },
    ],
  });
  project.ctx.runGate = async ({ run }) => {
    project.snapshot.project.paused = true;
    return blockedGate(run);
  };
  const out = await runPendingGates(project.ctx, { projectId });
  project.snapshot.project.paused = false;
  assert.equal(out.stopped, 'project_control_blocked');
});
