import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';

const worker = fileURLToPath(new URL('./fixtures/job-claim-worker.mjs', import.meta.url));
const Q = 'project:contention';

function child(home, owner, signal) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const proc = spawn(process.execPath, [worker, home, Q, owner], { env, signal, windowsHide: true });
  const closed = new Promise(resolve => proc.once('close', resolve));
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  let stderr = '';
  const recordError = error => (stderr += error.message + '\n');
  proc.on('error', recordError);
  proc.stdin.on('error', recordError);
  proc.stderr.on('data', data => (stderr += data));
  async function read() {
    const { done, value } = await lines.next();
    if (done) throw new Error(`${owner} exited before its response: ${stderr}`);
    return value;
  }
  return {
    read,
    async request(command) {
      proc.stdin.write(command + '\n');
      return JSON.parse(await read());
    },
    async close() {
      proc.stdin.end();
      const code = await closed;
      assert.equal(code, 0, stderr);
    },
  };
}

test('Four processes contending for one queue claim every job exactly once', { timeout: 120000 }, async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-job-contention-'));
  const store = new Store(home);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const jobs = openJobStore({ store });
  const total = 60;
  jobs.enqueue(
    Q,
    Array.from({ length: total }, (_, i) => ({ key: `j${i}`, role: 'developer', writePaths: [`src/j${i}.mjs`] })),
  );
  const workers = ['w1', 'w2', 'w3', 'w4'].map(owner => child(home, owner, t.signal));
  const claims = workers.map(() => []);
  let exits;
  try {
    for (const message of await Promise.all(workers.map(worker => worker.read()))) assert.equal(message, 'ready');
    for (;;) {
      const round = await Promise.all(workers.map(worker => worker.request('claim')));
      if (round.every(id => id === null)) break;
      // A fast writer cannot reacquire the SQLite lock for completion while a peer still waits to claim.
      const completed = await Promise.all(workers.map(worker => worker.request('complete')));
      assert.deepEqual(completed, round);
      round.forEach((id, index) => {
        if (id !== null) claims[index].push(id);
      });
    }
  } finally {
    exits = await Promise.allSettled(workers.map(worker => worker.close()));
  }
  for (const exit of exits) if (exit.status === 'rejected') throw exit.reason;
  const all = claims.flat();
  assert.equal(all.length, total, 'no claim was handed out twice');
  assert.equal(new Set(all).size, total, 'every job was claimed');
  assert.ok(
    claims.every(list => list.length > 0),
    'all four processes claimed work',
  );
  const rows = jobs.list(Q);
  assert.ok(rows.every(job => job.state === 'verifying' && job.attempt === 1));
  for (const job of rows)
    assert.equal(jobs.events(job.id).filter(event => event.type === 'claimed').length, 1, job.key);
});
