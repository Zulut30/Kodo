/** Opt-in bridge from one Engine run to the durable job queue
 * (`kodo.config.json`: `"scheduler": "durable"`). Plan nodes become jobs of the
 * queue `run:<runId>:<planHash>`; the queue decides what may start and what is
 * integrated, the Engine keeps doing the work: routing, worktrees, sessions,
 * repair budgets and merges are the existing `performNode`/`integrateNode`.
 * Node state in the Run stays the source of truth for a node's progress; a job
 * never gets ahead of its node, so a resumed run re-drives the queue without
 * repeating a recorded session or merge.
 */
import { contentHash } from './engine-core.mjs';
import { openJobStore } from './job-store.mjs';
import { runJobQueue } from './job-scheduler.mjs';

const roles = { developer: 'developer', tester: 'tester', documenter: 'documentation' };
const done = node => ['completed', 'integrated'].includes(node?.status);
/** Blocks the queue lifts by itself once their cause is gone. */
const automatic = /^(?:dependency|host_unavailable):/;

/** One queue per plan: a replaced plan never collides with jobs of the old one. */
export const jobQueueFor = run => `run:${run.id}:${contentHash(run.plan.tasks).slice(0, 12)}`;

/**
 * Fair reader/writer gate. A node that the plan or the router marked as not
 * parallel runs alone, exactly as the legacy dispatcher guarantees.
 */
function soloGate() {
  const waiting = [];
  let shared = 0,
    solo = false;
  const admit = () => {
    while (waiting.length) {
      const next = waiting[0];
      if (solo || (next.alone && shared)) return;
      waiting.shift();
      if (next.alone) solo = true;
      else shared++;
      next.enter();
    }
  };
  return async (alone, action) => {
    await new Promise(enter => {
      waiting.push({ alone, enter: () => enter(undefined) });
      admit();
    });
    try {
      return await action();
    } finally {
      if (alone) solo = false;
      else shared--;
      admit();
    }
  };
}

/** Enqueue the plan, void leases of a previous process and re-arm jobs for a new retry cycle. */
function prepareQueue(engine, run) {
  const jobs = openJobStore({ store: engine.store });
  const queue = jobQueueFor(run);
  jobs.enqueue(
    queue,
    run.plan.tasks.map(task => ({
      key: task.id,
      role: roles[task.role],
      dependsOn: task.dependsOn,
      writePaths: task.writePaths,
      // Repairs are the Engine's budget (`repairRounds`), not a second retry policy.
      retry: { maxAttempts: 1 },
      payload: { runId: run.id },
    })),
  );
  // The Run lease is exclusive, so any job lease left in this queue is stale.
  jobs.takeOver(queue);
  for (const job of jobs.list(queue)) {
    const manual =
      ['failed', 'cancelled'].includes(job.state) || (job.state === 'blocked' && !automatic.test(job.reason ?? ''));
    // A node stopped by its repair budget stays stopped until an explicit retry cycle resets it.
    if (manual && !run.nodes[job.key]?.stopped) jobs.retry(job.id);
  }
  return { jobs, queue };
}

/**
 * Drive the plan of `run` through the durable queue. Resolves once every node
 * is integrated; otherwise throws the same errors as the legacy dispatcher
 * (`quota`, `blocked`, `cancelled`, …) so `Engine.run` maps them unchanged.
 * @param {any} engine
 * @param {any} run
 * @param {AbortSignal} [signal]
 */
export async function executeDurableTasks(engine, run, signal) {
  const tasks = new Map(run.plan.tasks.map(task => [task.id, task]));
  const { jobs, queue } = prepareQueue(engine, run);
  engine.log(run, 'jobs_queue', { queue, workers: run.config.concurrency });
  const stop = new AbortController(),
    halt = () => stop.abort();
  signal?.addEventListener('abort', halt, { once: true });
  if (signal?.aborted) halt();
  const gate = soloGate();
  /** The first failure of this cycle. After it nothing new starts; running work drains. */
  let first;

  async function execute(job, context) {
    const task = tasks.get(job.key),
      node = (run.nodes[task.id] ||= { id: task.id, attempt: 0, status: 'pending' });
    try {
      while (!done(node)) {
        engine.checkCancelled(run, context.signal);
        const exhausted = node.stopped || node.attempt >= run.config.repairRounds;
        if (!exhausted && !node.routing) await engine.route(run, task, node, context.signal);
        const alone = !(task.parallel && node.routing?.parallel);
        await gate(alone, () => engine.performNode(run, task, context.signal));
      }
      return { node: task.id, headSha: node.headSha };
    } catch (error) {
      first ??= error;
      throw error;
    }
  }

  async function integrate(job, context) {
    const task = tasks.get(job.key);
    try {
      engine.checkCancelled(run, context.signal);
      context.confirmOwnership();
    } catch (error) {
      // Nothing was merged yet: the recorded result stays for the next cycle.
      first ??= error;
      halt();
      throw Object.assign(error, { integrated: false });
    }
    if (run.nodes[task.id].status === 'completed') await engine.integrateNode(run, task, context.signal);
    return { node: task.id, headSha: run.nodes[task.id].headSha };
  }

  let summary;
  try {
    summary = await runJobQueue({
      jobs,
      queue,
      owner: `engine:${run.id}`,
      limits: { workers: run.config.concurrency },
      signal: stop.signal,
      paused: () => first !== undefined,
      execute,
      integrate,
      // A pending merge was already recovered by `executeTasks`; the node tells whether it landed.
      reconcile: async job => {
        const node = run.nodes[job.key];
        return node?.status === 'integrated'
          ? { integrated: true, receipt: { node: job.key, headSha: node.headSha } }
          : { integrated: false };
      },
    });
  } catch (error) {
    throw first ?? error;
  } finally {
    signal?.removeEventListener('abort', halt);
  }
  engine.log(run, 'jobs_summary', { queue, status: summary.status, counts: summary.counts });
  if (summary.status === 'integrated') return;
  engine.checkCancelled(run, signal);
  if (first) throw first;
  // Nothing failed in this cycle: report the saved blocker exactly as the legacy path does.
  for (const task of run.plan.tasks) if (run.nodes[task.id]?.stopped) await engine.performNode(run, task, signal);
  if (summary.status === 'waiting_quota')
    throw Object.assign(new Error('Лимит провайдера: задания ждут квоту'), {
      code: 'quota',
      retryAt: new Date(summary.retryAt).toISOString(),
    });
  throw Object.assign(new Error(`Очередь заданий остановлена: ${summary.status}`), {
    code: summary.status === 'stalled' ? 'scheduler_deadlock' : 'blocked',
  });
}
