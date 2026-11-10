import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';

const worker = fileURLToPath(new URL('./fixtures/job-claim-worker.mjs', import.meta.url));
const Q = 'project:contention';

function child(home, owner, startAt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const proc = spawn(process.execPath, [worker, home, Q, owner, String(startAt)], { env, windowsHide: true });
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', data => (stdout += data));
    proc.stderr.on('data', data => (stderr += data));
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${owner}: ${stderr}`))));
  });
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
  const startAt = Date.now() + 3000; // After every child has loaded its modules.
  const claims = await Promise.all(['w1', 'w2', 'w3', 'w4'].map(owner => child(home, owner, startAt)));
  const all = claims.flat();
  assert.equal(all.length, total, 'no claim was handed out twice');
  assert.equal(new Set(all).size, total, 'every job was claimed');
  assert.ok(claims.filter(list => list.length > 0).length >= 2, 'the processes really competed');
  const rows = jobs.list(Q);
  assert.ok(rows.every(job => job.state === 'verifying' && job.attempt === 1));
  for (const job of rows)
    assert.equal(jobs.events(job.id).filter(event => event.type === 'claimed').length, 1, job.key);
});
