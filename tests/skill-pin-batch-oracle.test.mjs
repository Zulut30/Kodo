import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSkillIds, loadDefaultPolicy, verifyDefaultSkillPins } from '../runtime/skill-policy.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = { ...fs };
const digest = data => createHash('sha256').update(data).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
const lockName = 'third-party-skills.lock.json';
const baselineContextHash = 'a295656430553dcbf0cfd30488765c5b55978df9a3209c2557a5a10b54738542';

async function fixture(t) {
  const directory = await native.mkdtemp(path.join(os.tmpdir(), 'kodo-pin-oracle-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-pin-oracle-'));
    await native.rm(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'bundle with spaces');
  const project = path.join(directory, 'empty-project');
  await native.mkdir(root);
  await native.mkdir(project);
  await native.cp(path.join(sourceRoot, 'skills'), path.join(root, 'skills'), { recursive: true });
  const lockBytes = await native.readFile(path.join(sourceRoot, lockName));
  await native.writeFile(path.join(root, lockName), lockBytes);
  const lock = JSON.parse(lockBytes);
  const records = lock.components.flatMap(component => component.files);
  assert.equal(records.length, 183, 'the real baseline bundle contains all 183 pins');
  const expected = new Map();
  for (const file of records) {
    const bytes = await native.readFile(path.join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(digest(bytes), file.sha256, file.path);
    expected.set(file.path, bytes.toString('utf8'));
  }
  return { directory, root, project, lock, lockBytes, records, expected };
}

// Observe the builtin boundary, never a production injection port. The barrier
// releases only when actual filesystem work has become idle. A serial caller
// therefore finishes with peak=1 rather than hanging while waiting for siblings.
// Parallel callers reach the barrier together, independent of disk latency.
async function observed(bundle, run, { release, failures = new Map() } = {}) {
  const pinned = new Set(bundle.records.map(file => path.resolve(bundle.root, file.path)));
  const reads = [],
    stats = [],
    pending = new Set(),
    held = [];
  const state = { active: 0, peak: 0, nativeActive: 0, settled: false, releases: 0 };
  let scheduled = false,
    stopping = false,
    controlError;
  const relative = filename => path.relative(bundle.root, filename).replaceAll('\\', '/');
  const inside = filename =>
    typeof filename === 'string' &&
    (path.resolve(filename) === bundle.root || path.resolve(filename).startsWith(bundle.root + path.sep));
  function pump() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(async () => {
      scheduled = false;
      if (state.nativeActive || !held.length) return;
      const batch = held.splice(0);
      state.releases++;
      try {
        if (release && !stopping) await release(batch, state);
      } catch (error) {
        controlError = error;
      } finally {
        for (const entry of batch) entry.resolve();
      }
    });
  }
  function track(promise) {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  fs.lstat = (...args) => {
    if (!inside(args[0])) return native.lstat(...args);
    stats.push(relative(args[0]));
    state.nativeActive++;
    return track(
      (async () => {
        try {
          return await native.lstat(...args);
        } finally {
          state.nativeActive--;
          pump();
        }
      })(),
    );
  };
  fs.readFile = (...args) => {
    if (!inside(args[0])) return native.readFile(...args);
    const filename = path.resolve(args[0]);
    const name = relative(filename);
    reads.push(name);
    if (!pinned.has(filename)) return native.readFile(...args);
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    state.nativeActive++;
    return track(
      (async () => {
        try {
          let bytes, failure;
          try {
            bytes = await native.readFile(...args);
          } catch (error) {
            failure = error;
          } finally {
            state.nativeActive--;
          }
          await new Promise(resolve => {
            held.push({ name, resolve });
            pump();
          });
          if (failures.has(name)) throw Object.assign(new Error(failures.get(name)), { code: 'EIO' });
          if (failure) throw failure;
          return bytes;
        } finally {
          state.active--;
        }
      })(),
    );
  };
  syncBuiltinESMExports();
  let outcome;
  try {
    outcome = await Promise.resolve()
      .then(run)
      .then(
        value => {
          state.settled = true;
          return { value, activeAtSettlement: state.active, nativeAtSettlement: state.nativeActive };
        },
        error => {
          state.settled = true;
          return { error, activeAtSettlement: state.active, nativeAtSettlement: state.nativeActive };
        },
      );
  } finally {
    // Even a broken fail-fast implementation must leave no spy or suspended
    // readonly operation behind after this test has recorded its failure.
    stopping = true;
    while (pending.size) {
      for (const entry of held.splice(0)) entry.resolve();
      await Promise.allSettled([...pending]);
    }
    fs.lstat = native.lstat;
    fs.readFile = native.readFile;
    syncBuiltinESMExports();
  }
  if (controlError) throw controlError;
  return { ...outcome, reads, stats, ...state };
}

function assertDrained(observation) {
  assert.equal(observation.activeAtSettlement, 0, 'all started resource reads settle before the public promise');
  assert.equal(
    observation.nativeAtSettlement,
    0,
    'all started native lstat/read operations settle before the public promise',
  );
}

function assertFresh(bundle, observation) {
  assert.equal(observation.error, undefined);
  assertDrained(observation);
  const counts = new Map();
  for (const name of observation.reads) counts.set(name, (counts.get(name) || 0) + 1);
  assert.equal(counts.get(lockName), 1, 'the provenance lock is freshly read');
  for (const file of bundle.records) {
    assert.equal(counts.get(file.path), 1, `fresh bytes: ${file.path}`);
    const parts = file.path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      assert.ok(observation.stats.includes(parts.slice(0, index).join('/')), `fresh path guard: ${file.path}`);
    }
    assert.ok(
      observation.stats.filter(name => name === file.path).length >= 2,
      `fresh regular-file guard: ${file.path}`,
    );
  }
  assert.ok(observation.stats.filter(name => name === '').length >= 184, 'every read rechecks the real root');
  assert.equal(observation.reads.filter(name => bundle.expected.has(name)).length, 183);
}

function integrity(error, message) {
  assert.equal(error?.code, 'skill_integrity');
  assert.equal(error.message, `Default skill integrity: ${message}`);
  return true;
}

test('Pin batch oracle', { concurrency: false }, async t => {
  const bundle = await fixture(t);
  const verify = () => verifyDefaultSkillPins(bundle.root);
  const policy = () =>
    loadDefaultPolicy({ root: bundle.root, project: bundle.project, stage: 'tester', task: 'Review command parser' });

  await t.test('Fresh reads overlap within the hard four-read bound and retain all 183 ordered resources', async t => {
    const peaks = [];
    for (let call = 1; call <= 3; call++) {
      const observation = await observed(bundle, verify);
      assertFresh(bundle, observation);
      assert.deepEqual(observation.value.lock, bundle.lock);
      assert.deepEqual(
        [...observation.value.byId],
        bundle.lock.components.map(component => [component.id, component]),
      );
      assert.deepEqual([...observation.value.resources], [...bundle.expected]);
      t.diagnostic(`call=${call} real pinned reads=183 peak=${observation.peak}`);
      peaks.push(observation.peak);
    }
    for (const peak of peaks) {
      assert.ok(peak > 1, `required controlled FS overlap >1; actual peak=${peak}`);
      assert.ok(peak <= 4, `hard bound=4; actual peak=${peak}`);
    }
  });

  await t.test('Read completion order cannot reorder Maps or the frozen baseline context and hash', async () => {
    const observations = [];
    for (let call = 0; call < 2; call++) {
      observations.push(
        await observed(bundle, policy, {
          release: async entries => {
            for (const entry of entries.toReversed()) {
              entry.resolve();
              await turn();
            }
          },
        }),
      );
    }
    for (const observation of observations) {
      assertFresh(bundle, observation);
      const result = observation.value;
      assert.deepEqual(
        result.skills.map(row => row.id),
        [...defaultSkillIds],
      );
      assert.deepEqual(
        result.skills.filter(row => row.applies).map(row => row.id),
        [
          'skills/e2e-testing-patterns',
          'skills/subagent-driven-development',
          'skills/systematic-debugging',
          'skills/test-driven-development',
          'skills/using-git-worktrees',
        ],
      );
      const normalized = result.context
        .replace(/\]\(<([^>]+)>\)/g, ']($1)')
        .replaceAll(bundle.root.replaceAll('\\', '/'), '<BUNDLE>');
      assert.equal(
        digest(normalized),
        baselineContextHash,
        'exact pre-change public context, normalized only for its temporary root',
      );
      assert.equal(
        result.hash,
        digest(
          JSON.stringify({
            policyVersion: 1,
            provenanceVersion: 1,
            facts: { react: false, monorepo: false, reactVersion: null, manifests: [], markers: [] },
            context: result.context,
          }),
        ),
      );
    }
    assert.deepEqual(observations[1].value, observations[0].value);
    const maps = await observed(bundle, verify, {
      release: async entries => {
        for (const entry of entries.toReversed()) {
          entry.resolve();
          await turn();
        }
      },
    });
    assertFresh(bundle, maps);
    assert.deepEqual([...maps.value.resources], [...bundle.expected]);
    assert.deepEqual(
      [...maps.value.byId],
      bundle.lock.components.map(component => [component.id, component]),
    );
  });

  await t.test('A later faster read failure cannot replace the first lock-order error', async () => {
    const [first, second] = bundle.records;
    let reversed = false,
      pendingAfterLaterFailure = false;
    const observation = await observed(bundle, verify, {
      failures: new Map([
        [first.path, 'oracle-first-read'],
        [second.path, 'oracle-second-read'],
      ]),
      release: async (entries, state) => {
        const later = entries.find(entry => entry.name === second.path);
        const earlier = entries.find(entry => entry.name === first.path);
        if (earlier && later) {
          reversed = true;
          later.resolve();
          await turn();
          pendingAfterLaterFailure = !state.settled;
          earlier.resolve();
        }
      },
    });
    integrity(observation.error, `cannot read ${first.path}: oracle-first-read`);
    assertDrained(observation);
    assert.equal(reversed, true, 'both real sibling reads started before either failure was released');
    assert.equal(pendingAfterLaterFailure, true, 'a faster later error cannot reject ahead of the first file');
    assert.ok(observation.peak <= 4);
  });

  await t.test('A failed first read waits for every started readonly sibling before rejecting', async () => {
    const first = bundle.records[0];
    let sawPendingSibling = false,
      pendingAfterFirstFailure = false;
    const observation = await observed(bundle, verify, {
      failures: new Map([[first.path, 'oracle-drain-read']]),
      release: async (entries, state) => {
        const failed = entries.find(entry => entry.name === first.path);
        if (!failed) return;
        sawPendingSibling = entries.length > 1;
        failed.resolve();
        await turn();
        pendingAfterFirstFailure = !state.settled && state.active > 0;
      },
    });
    integrity(observation.error, `cannot read ${first.path}: oracle-drain-read`);
    assertDrained(observation);
    assert.equal(sawPendingSibling, true, 'the controlled failing group contains started siblings');
    assert.equal(
      pendingAfterFirstFailure,
      true,
      'the public promise remains pending while successful siblings are held',
    );
    assert.ok(observation.peak <= 4);
  });

  await t.test('An earlier hash mismatch wins over a faster later read error', async () => {
    const [first, second] = bundle.records;
    const firstName = path.join(bundle.root, first.path);
    const bytes = await native.readFile(firstName);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    await native.writeFile(firstName, changed);
    try {
      const observation = await observed(bundle, verify, {
        failures: new Map([[second.path, 'oracle-after-hash']]),
        release: async entries => {
          for (const entry of entries.toReversed()) {
            entry.resolve();
            await turn();
          }
        },
      });
      integrity(observation.error, `hash mismatch: ${first.path}`);
      assertDrained(observation);
      assert.ok(observation.peak <= 4);
    } finally {
      await native.writeFile(firstName, bytes);
    }
  });

  await t.test(
    'An earlier byte failure wins over a later malformed file record without abandoning started reads',
    async () => {
      const lock = structuredClone(bundle.lock);
      lock.components[0].files[1].sha256 = 'invalid';
      await native.writeFile(path.join(bundle.root, lockName), JSON.stringify(lock));
      try {
        const first = bundle.records[0];
        const observation = await observed(bundle, verify, {
          failures: new Map([[first.path, 'oracle-before-metadata']]),
        });
        integrity(observation.error, `cannot read ${first.path}: oracle-before-metadata`);
        assertDrained(observation);
      } finally {
        await native.writeFile(path.join(bundle.root, lockName), bundle.lockBytes);
      }
    },
  );

  await t.test('A malformed file record after valid reads rejects only after draining them', async () => {
    const lock = structuredClone(bundle.lock);
    lock.components[0].files[2].bytes = 0;
    await native.writeFile(path.join(bundle.root, lockName), JSON.stringify(lock));
    try {
      const observation = await observed(bundle, verify);
      integrity(observation.error, `invalid file record: ${bundle.lock.components[0].id}`);
      assertDrained(observation);
      assert.ok(observation.peak <= 4);
    } finally {
      await native.writeFile(path.join(bundle.root, lockName), bundle.lockBytes);
    }
  });

  const unused = bundle.lock.components.find(component => component.id === 'skills/react-best-practices').files.at(-1);
  const filename = path.join(bundle.root, unused.path);
  const originalBytes = await native.readFile(filename);
  const originalStat = await native.stat(filename);
  const corruptions = [
    {
      name: 'same-size corruption with restored mtime',
      change: async () => {
        const changed = Buffer.from(originalBytes);
        changed[0] ^= 1;
        await native.writeFile(filename, changed);
        await native.utimes(filename, originalStat.atime, originalStat.mtime);
      },
      message: `hash mismatch: ${unused.path}`,
    },
    {
      name: 'changed byte count',
      change: () => native.writeFile(filename, Buffer.concat([originalBytes, Buffer.from('\n')])),
      message: `hash mismatch: ${unused.path}`,
    },
    {
      name: 'changed pinned hash',
      lock: lock => {
        lock.components.find(row => row.id === 'skills/react-best-practices').files.at(-1).sha256 = '0'.repeat(64);
      },
      message: `hash mismatch: ${unused.path}`,
    },
    { name: 'missing source', change: () => native.unlink(filename), pattern: /cannot read .*ENOENT/ },
    {
      name: 'non-regular source',
      change: async () => {
        await native.unlink(filename);
        await native.mkdir(filename);
      },
      message: `cannot read ${unused.path}: Default skill integrity: resource is not a regular file: ${unused.path}`,
    },
    {
      name: 'unsupported license',
      lock: lock => {
        lock.components.at(-1).license.spdx = 'UNLICENSED';
      },
      message: `missing entry point or license: ${bundle.lock.components.at(-1).id}`,
    },
    {
      name: 'missing license pin',
      lock: lock => {
        lock.components.at(-1).license.localPath += '.missing';
      },
      message: `missing entry point or license: ${bundle.lock.components.at(-1).id}`,
    },
    {
      name: 'missing entry point pin',
      lock: lock => {
        lock.components.at(-1).entryPoint += '.missing';
      },
      message: `missing entry point or license: ${bundle.lock.components.at(-1).id}`,
    },
    {
      name: 'changed provenance revision',
      lock: lock => {
        lock.components.at(-1).revision = 'main';
      },
      message: `invalid component record: ${bundle.lock.components.at(-1).id}`,
    },
  ];
  for (const item of corruptions) {
    await t.test(`A prior PASS cannot hide ${item.name} in a later policy load`, async () => {
      const before = await policy();
      assert.equal(before.skills.find(row => row.id === 'skills/react-best-practices').applies, false);
      try {
        if (item.change) await item.change();
        if (item.lock) {
          const lock = structuredClone(bundle.lock);
          item.lock(lock);
          await native.writeFile(path.join(bundle.root, lockName), JSON.stringify(lock));
        }
        await assert.rejects(policy, error => {
          if (item.message) return integrity(error, item.message);
          assert.equal(error.code, 'skill_integrity');
          assert.match(error.message, item.pattern);
          return true;
        });
      } finally {
        await native.rm(filename, { recursive: true, force: true });
        await native.writeFile(filename, originalBytes);
        await native.writeFile(path.join(bundle.root, lockName), bundle.lockBytes);
      }
      assert.equal((await policy()).hash, before.hash, 'repaired bytes produce the same context and hash');
    });
  }

  await t.test('A prior PASS cannot hide a real resource junction or linked bundle root', async () => {
    const before = await policy();
    const target = path.join(bundle.directory, 'junction-target');
    const rootLink = path.join(bundle.directory, 'bundle-link');
    await native.mkdir(target);
    try {
      await native.unlink(filename);
      await native.symlink(target, filename, 'junction');
      assert.equal((await native.lstat(filename)).isSymbolicLink(), true);
      await assert.rejects(policy, error =>
        integrity(
          error,
          `cannot read ${unused.path}: Default skill integrity: resource link is not allowed: ${unused.path}`,
        ),
      );
    } finally {
      await native.unlink(filename);
      await native.writeFile(filename, originalBytes);
    }
    await native.symlink(bundle.root, rootLink, 'junction');
    try {
      await assert.rejects(
        () => verifyDefaultSkillPins(rootLink),
        error => integrity(error, 'bundle root must be a real directory'),
      );
    } finally {
      await native.unlink(rootLink);
    }
    assert.equal((await policy()).hash, before.hash);
  });

  await t.test('A prior PASS cannot hide a real intermediate directory junction', async () => {
    const before = await policy();
    const component = bundle.lock.components.find(row => row.id === 'skills/react-best-practices');
    const upstream = path.join(bundle.root, component.id, 'references/upstream');
    const parked = path.join(bundle.directory, 'parked-upstream');
    await native.rename(upstream, parked);
    let linked = false;
    try {
      await native.symlink(parked, upstream, 'junction');
      linked = true;
      assert.equal((await native.lstat(upstream)).isSymbolicLink(), true);
      const first = component.files[0].path;
      await assert.rejects(policy, error =>
        integrity(error, `cannot read ${first}: Default skill integrity: resource link is not allowed: ${first}`),
      );
    } finally {
      if (linked) await native.unlink(upstream);
      await native.rename(parked, upstream);
    }
    assert.equal((await policy()).hash, before.hash);
  });
});
