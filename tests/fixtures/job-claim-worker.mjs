// Child process for tests/job-concurrency.test.mjs: claim and complete jobs from
// a shared state database until the queue has nothing left to hand out. Every
// child starts claiming at the same wall-clock instant so they really contend.
import { Store } from '../../runtime/store.mjs';
import { openJobStore } from '../../runtime/job-store.mjs';

const [home, queue, owner, startAt] = process.argv.slice(2);
const store = new Store(home);
const jobs = openJobStore({ store });
const claimed = [];
const pause = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(pause, 0, 0, Math.max(0, Number(startAt) - Date.now()));
for (;;) {
  const run = jobs.claim(queue, { owner, limits: { workers: 8, pools: {} } });
  if (run.job) {
    claimed.push(run.job.id);
    jobs.complete(run.job.id, run.token, { owner });
    // SQLite hands a released lock back to its last holder; yield so the others interleave.
    Atomics.wait(pause, 0, 0, 5);
  } else if (jobs.list(queue).some(job => job.state === 'queued' || job.state === 'running')) Atomics.wait(pause, 0, 0, 2);
  else break;
}
store.close();
process.stdout.write(JSON.stringify(claimed));
