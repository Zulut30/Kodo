/** Foreground driver for one durable job queue: start admitted jobs up to the
 * worker limit and integrate recorded results one at a time. All admission and
 * ownership decisions stay in `job-store.mjs`; this loop only supplies the
 * caller's `execute`, `integrate` and `reconcile` ports and reports honestly
 * what is left. It is not a second orchestrator: a job is whatever the caller
 * executes (for Kodo, one scoped Engine run), and workers never integrate.
 */

/**
 * @typedef {object} JobQueueOptions
 * @property {ReturnType<typeof import('./job-store.mjs').openJobStore>} jobs
 * @property {string} queue
 * @property {string} owner Lease owner name of this coordinator process.
 * @property {import('./job-contracts.mjs').JobLimits} limits
 * @property {import('./job-contracts.mjs').HostConnections} [hosts]
 * @property {{ capabilities?: string[], tools?: string[] }} [worker]
 * @property {(job: import('./job-store.mjs').Job, context: { signal: AbortSignal }) => Promise<Record<string, any> | void>} execute
 *   Run one job in isolation and return its result. Reject with `code: 'quota'`
 *   (optional `retryAt`, `checkpoint`) to pause, or `retryable: false` to fail for good.
 * @property {(job: import('./job-store.mjs').Job, context: { signal: AbortSignal }) => Promise<Record<string, any> | void>} integrate
 *   Integrate one recorded result and return a receipt. Reject with
 *   `integrated: false` only when the integration is known to be absent.
 * @property {(job: import('./job-store.mjs').Job) => Promise<{ integrated: boolean, receipt?: Record<string, any> }>} [reconcile]
 *   Decide whether an interrupted integration landed.
 * @property {AbortSignal} [signal] Stop: running jobs are handed back, nothing is cancelled durably.
 * @property {number} [ttlMs]
 * @property {number} [heartbeatMs]
 * @property {() => number} [now]
 */

const fail = (code, message) => Object.assign(new Error(`Job: ${message}`), { code: `job_${code}` });
const leaseLost = error => error?.code === 'job_lease_lost';

/** When a quota error allows the next attempt. */
function retryTime(error, now) {
  const parsed = typeof error.retryAt === 'number' ? error.retryAt : Date.parse(error.retryAt);
  return Number.isSafeInteger(parsed) && parsed > now ? parsed : now + 60000;
}

/** Honest end state of a queue once this process has nothing left to do. */
function summarize(jobs, queue, { stopped, waiting }) {
  const rows = jobs.list(queue);
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  const quota = rows.filter(row => row.state === 'waiting_quota').map(row => row.retryAt);
  const status = stopped
    ? 'stopped'
    : rows.every(row => row.state === 'integrated')
      ? 'integrated'
      : quota.length
        ? 'waiting_quota'
        : counts.running || counts.integrating || counts.verifying
          ? 'busy' // Owned by another process, or an interrupted integration awaits its lease expiry.
          : counts.queued
            ? 'stalled'
            : 'blocked';
  return {
    status,
    counts,
    ...(status === 'waiting_quota' ? { retryAt: Math.min(...quota) } : {}),
    ...(status === 'stalled' ? { waiting } : {}),
  };
}

/**
 * Drive a queue until nothing more can start or integrate from this process.
 * Resolves with a summary; rejects only for an integration whose outcome is
 * unknown (the job stays `integrating` for reconciliation) or a broken port.
 * @param {JobQueueOptions} options
 */
export async function runJobQueue(options) {
  const { jobs, queue, owner, limits, hosts, worker, execute, integrate, reconcile, signal } = options;
  const ttlMs = options.ttlMs ?? 60000,
    heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(ttlMs / 3)),
    now = options.now ?? Date.now;
  const active = new Map();
  let integrating = false,
    fatal,
    wake,
    waiting = [];
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  /** A store report from a worker that no longer owns its job is dropped, never trusted. */
  const report = operation => {
    try {
      operation();
    } catch (error) {
      if (!leaseLost(error)) fatal ??= error;
    }
  };
  /** Keep a lease alive; stop the work as soon as ownership is gone. */
  const guard = (job, token) => {
    const controller = new AbortController();
    const beat = () => {
      let alive;
      try {
        alive = jobs.heartbeat(job.id, token, { ttlMs }).ok;
      } catch {
        alive = false;
      }
      if (!alive) controller.abort();
    };
    const timer = setInterval(beat, heartbeatMs);
    timer.unref();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    return {
      signal: controller.signal,
      end() {
        clearInterval(timer);
        signal?.removeEventListener('abort', stop);
      },
    };
  };

  function failed(job, token, error) {
    if (signal?.aborted) return jobs.release(job.id, token, { reason: 'stopped' });
    if (error?.code === 'quota')
      return jobs.waitQuota(job.id, token, {
        retryAt: retryTime(error, now()),
        reason: error.message,
        ...(error.checkpoint ? { checkpoint: error.checkpoint } : {}),
      });
    return jobs.fail(job.id, token, { reason: error?.message, retryable: error?.retryable !== false });
  }

  function start({ job, token }) {
    const lease = guard(job, token);
    active.set(job.id, lease);
    Promise.resolve()
      .then(() => execute(job, { signal: lease.signal }))
      .then(
        result => report(() => jobs.complete(job.id, token, result ?? {})),
        error => report(() => failed(job, token, error)),
      )
      .finally(() => {
        lease.end();
        active.delete(job.id);
        notify();
      });
  }

  async function integrateOne({ job, token, recovery }) {
    const lease = guard(job, token);
    try {
      if (recovery) {
        if (!reconcile) throw fail('reconcile_required', `interrupted integration of ${job.key}`);
        const outcome = await reconcile(job);
        if (outcome?.integrated) jobs.finishIntegration(job.id, token, outcome.receipt ?? {});
        else jobs.abortIntegration(job.id, token, { reason: 'reconciled_absent' });
        return;
      }
      let receipt;
      try {
        receipt = await integrate(job, { signal: lease.signal });
      } catch (error) {
        // Only a confirmed absence may be retried; anything else stays owned for reconciliation.
        if (error?.integrated !== false) throw error;
        jobs.abortIntegration(job.id, token, { reason: error.message, retry: error.retryable !== false });
        return;
      }
      jobs.finishIntegration(job.id, token, receipt ?? {});
    } finally {
      lease.end();
    }
  }

  function dispatch() {
    if (!integrating) {
      const slot = jobs.beginIntegration(queue, { owner, ttlMs });
      if (slot) {
        integrating = true;
        integrateOne(slot)
          .catch(error => {
            if (!leaseLost(error)) fatal ??= error;
          })
          .finally(() => {
            integrating = false;
            notify();
          });
      }
    }
    while (active.size < limits.workers) {
      const claimed = jobs.claim(queue, { owner, ttlMs, limits, hosts, worker });
      waiting = claimed.waiting;
      if (!claimed.job) break;
      start(claimed);
    }
  }

  const stop = () => notify();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      if (!fatal && !signal?.aborted) {
        try {
          dispatch();
        } catch (error) {
          fatal = error;
        }
      }
      if (!active.size && !integrating) {
        if (fatal) throw fatal;
        return summarize(jobs, queue, { stopped: Boolean(signal?.aborted), waiting });
      }
      await new Promise(resolve => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
