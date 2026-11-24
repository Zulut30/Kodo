// One real store connection per OS process. The parent releases all claimants
// together for each round and closes stdin after observing an empty queue.
import { createInterface } from 'node:readline';
import { Store } from '../../runtime/store.mjs';
import { openJobStore } from '../../runtime/job-store.mjs';

const [home, queue, owner] = process.argv.slice(2);
const store = new Store(home);
try {
  const jobs = openJobStore({ store });
  const rounds = createInterface({ input: process.stdin });
  process.stdout.write('ready\n');
  let run;
  for await (const command of rounds) {
    if (command === 'claim' && !run) {
      run = jobs.claim(queue, { owner, limits: { workers: 8, pools: {} } });
      process.stdout.write(JSON.stringify(run.job?.id ?? null) + '\n');
    } else if (command === 'complete' && run) {
      if (run.job) jobs.complete(run.job.id, run.token, { owner });
      process.stdout.write(JSON.stringify(run.job?.id ?? null) + '\n');
      run = null;
    } else throw new Error('Unexpected worker command');
  }
} finally {
  store.close();
}
