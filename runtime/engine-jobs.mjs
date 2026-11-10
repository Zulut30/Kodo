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
 * Fair reader/writer gate with the meaning of `busy` in the legacy dispatcher.
 * A node holds it from the start of an attempt until its result is integrated.
 * A node that the plan or the router marked as not parallel holds it alone, so
 * the next node always starts from the integrated result. `stop()` wakes every
 * waiter with `null`: after the first failure nothing new may start.
 */
function soloGate() {
  const waiting = [];
  let shared = 0,
    solo = false,
    stopped = false;
  const admit = () => {
    while (waiting.length) {
      const next = waiting[0];
      if (!stopped && (solo || (next.alone && shared))) return;
      waiting.shift();
      if (stopped) {
        next.enter(null);
        continue;
      }
      if (next.alone) solo = true;
      else shared++;
      let held = true;
      next.enter(() => {
        if (!held) return;
        held = false;
        if (next.alone) solo = false;
        else shared--;
        admit();
      });
    }
  };
  return {
    /** @returns {Promise<(() => void) | null>} A release function, or null once the gate was stopped. */
    enter: alone =>
      new Promise(enter => {
        waiting.push({ alone, enter });
        admit();
      }),
    stop() {
      stopped = true;
      admit();
    },
  };
}

/** Enqueue the plan, void leases of a previous process and re-arm jobs for a new retry cycle. */
function prepareQueue(engine, run) {
  const jobs = openJobStore({ store: engine.store });
  const queue = jobQueueFor(run);
  // The Run lease is exclusive, so any job lease left in a queue of this run is stale.
  for (const other of jobs.queues().filter(name => name.startsWith(`run:${run.id}:`) && name !== queue)) {
    // A replaced plan: its unfinished jobs will never run and must not look alive.
    jobs.takeOver(other);
    // An integration of the old plan cannot be cancelled in flight. The Engine refuses to replace
    // a plan with an integrated node, so nothing of it landed: record the absence, then cancel.
    for (let slot; (slot = jobs.beginIntegration(other, { owner: `engine:${run.id}` }));)
      jobs.abortIntegration(slot.job.id, slot.token, { reason: 'plan_replaced', retry: false });
    for (const job of jobs.list(other))
      if (!['integrated', 'cancelled'].includes(job.state)) jobs.cancel(job.id, { reason: 'plan_replaced' });
  }
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
  jobs.takeOver(queue);
  for (const job of jobs.list(queue)) {
    const manual =
      ['failed', 'cancelled'].includes(job.state) || (job.state === 'blocked' && !automatic.test(job.reason ?? ''));
    if (manual) jobs.retry(job.id);
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
  // A node its repair budget already stopped is the blocker of this run. Report it,
  // exactly as `performNode` does, before any other node may spend a session.
  for (const task of run.plan.tasks) if (run.nodes[task.id]?.stopped) await engine.performNode(run, task, signal);
  // A node whose session finished but whose result is not merged yet (a stop or a crash in
  // between) is integrated first, as the legacy dispatcher does for a pending merge. No other
  // node may start from a base without it. `integrateNode` is idempotent.
  for (const task of run.plan.tasks)
    if (run.nodes[task.id]?.status === 'completed') {
      engine.checkCancelled(run, signal);
      await engine.integrateNode(run, task, signal);
    }
  const { jobs, queue } = prepareQueue(engine, run);
  engine.log(run, 'jobs_queue', { queue, workers: run.config.concurrency });
  const stop = new AbortController(),
    gate = soloGate(),
    /** Gate holds by node id: from the start of an attempt until the node is integrated. */
    holds = new Map();
  const letGo = id => {
    holds.get(id)?.();
    holds.delete(id);
  };
  // A stop must also wake nodes waiting for the gate: its holders may never be integrated now.
  const halt = () => {
    stop.abort();
    gate.stop();
  };
  signal?.addEventListener('abort', halt, { once: true });
  if (signal?.aborted) halt();
  /** The first failure of this cycle. After it no session starts; the running attempt and recorded results drain. */
  let first;
  const failed = error => {
    first ??= error;
    gate.stop();
    return error;
  };
  const handBack = () => Object.assign(new Error('The queue is draining after its first failure'), { handBack: true });
  /** A job lease lost without a requested cancel is a lost lease, not a cancelled run. */
  const leaseLoss = (error, context) =>
    (error?.code === 'job_lease_lost' ||
      ((error?.code === 'cancelled' || error?.name === 'AbortError') && context.signal.aborted)) &&
    !stop.signal.aborted &&
    !engine.store.getRun(run.id).cancelRequested
      ? Object.assign(new Error('Аренда задания потеряна: исполнение узла остановлено'), { code: 'lease_lost' })
      : error;

  async function execute(job, context) {
    const task = tasks.get(job.key),
      node = (run.nodes[task.id] ||= { id: task.id, attempt: 0, status: 'pending' });
    try {
      while (!done(node)) {
        // After a failure elsewhere a node starts no session, not even its own next repair attempt.
        if (first) throw handBack();
        engine.checkCancelled(run, context.signal);
        const exhausted = node.stopped || node.attempt >= run.config.repairRounds;
        if (!exhausted && !node.routing) await engine.route(run, task, node, context.signal);
        const release = await gate.enter(!(task.parallel && node.routing?.parallel));
        if (!release || first) {
          release?.();
          throw handBack();
        }
        holds.set(task.id, release);
        await engine.performNode(run, task, context.signal);
        // A failed attempt frees the gate; routing, and with it the right to run alongside others, is decided again.
        if (!done(node)) letGo(task.id);
      }
      return { node: task.id, headSha: node.headSha };
    } catch (error) {
      // Record the failure before the gate is freed: a waiting node must wake to a stopped queue.
      const failure = error.handBack ? error : failed(leaseLoss(error, context));
      letGo(task.id);
      throw failure;
    }
  }

  async function integrate(job, context) {
    const task = tasks.get(job.key);
    try {
      try {
        engine.checkCancelled(run, context.signal);
        context.confirmOwnership();
      } catch (error) {
        // Nothing was merged yet: the recorded result stays for the next cycle.
        const failure = failed(leaseLoss(error, context));
        halt();
        throw Object.assign(failure, { integrated: false });
      }
      try {
        if (run.nodes[task.id]?.status === 'completed') await engine.integrateNode(run, task, context.signal);
        // A job must never get ahead of its node.
        if (run.nodes[task.id]?.status !== 'integrated')
          throw Object.assign(new Error(`Узел ${task.id} не интегрирован, задание не может быть завершено`), {
            code: 'merge_state',
          });
      } catch (error) {
        // The outcome of the merge is unknown to the queue: stop, keep ownership for reconciliation.
        throw failed(leaseLoss(error, context));
      }
      return { node: task.id, headSha: run.nodes[task.id].headSha };
    } finally {
      letGo(task.id);
    }
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
      // A store failure stops the queue without calling a port: wake the nodes waiting on the gate.
      onFatal: failed,
      // Test harness only: production uses the queue defaults.
      ...(engine.jobTiming?.ttlMs ? { ttlMs: engine.jobTiming.ttlMs } : {}),
      ...(engine.jobTiming?.heartbeatMs ? { heartbeatMs: engine.jobTiming.heartbeatMs } : {}),
    });
  } catch (error) {
    throw first ?? error;
  } finally {
    signal?.removeEventListener('abort', halt);
    gate.stop();
  }
  engine.log(run, 'jobs_summary', { queue, status: summary.status, counts: summary.counts });
  if (summary.status === 'integrated' && run.plan.tasks.every(task => run.nodes[task.id]?.status === 'integrated'))
    return;
  engine.checkCancelled(run, signal);
  if (first) throw first;
  if (summary.status === 'waiting_quota')
    throw Object.assign(new Error('Лимит провайдера: задания ждут квоту'), {
      code: 'quota',
      retryAt: new Date(summary.retryAt).toISOString(),
    });
  throw Object.assign(new Error(`Очередь заданий остановлена: ${summary.status}`), {
    code: summary.status === 'stalled' ? 'scheduler_deadlock' : 'blocked',
  });
}
