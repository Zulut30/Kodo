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
 *   (optional `retryAt`, `checkpoint`) to pause, `retryable: false` to fail for good, or
 *   `handBack: true` to return the job to the queue without a verdict or a spent attempt.
 * @property {(job: import('./job-store.mjs').Job, context: { signal: AbortSignal, confirmOwnership: () => void }) => Promise<Record<string, any> | void>} integrate
 *   Integrate one recorded result and return a receipt. Call `confirmOwnership()`
 *   immediately before the irreversible step: it throws once the lease is gone.
 *   Reject with `integrated: false` only when the integration is known to be absent.
 * @property {(job: import('./job-store.mjs').Job) => Promise<{ integrated: boolean, receipt?: Record<string, any> }>} [reconcile]
 *   Decide whether an interrupted integration landed.
 * @property {AbortSignal} [signal] Stop: running jobs are handed back, nothing is cancelled durably.
 * @property {() => boolean} [paused] While it returns true no new job starts; running jobs finish and results still integrate.
 * @property {number} [ttlMs]
 * @property {number} [heartbeatMs]
 * @property {() => number} [now]
 */

const fail = (code, message) => Object.assign(new Error(`Job: ${message}`), { code: `job_${code}` });
const leaseLost = error => error?.code === 'job_lease_lost';
/** The store refused caller data (not JSON, too large, or containing a secret). */
const rejected = error => ['job_payload_invalid', 'job_secret_redaction_required'].includes(error?.code);

/** When a quota error allows the next attempt. */
function retryTime(error, now) {
  const parsed = typeof error.retryAt === 'number' ? error.retryAt : Date.parse(error.retryAt);
  return Number.isSafeInteger(parsed) && parsed > now ? parsed : now + 60000;
}

/** Honest end state of a queue once this process has nothing left to do. */
function summarize(jobs, queue, { stopped, waiting, now }) {
  const rows = jobs.list(queue);
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  const quota = rows.filter(row => row.state === 'waiting_quota' && row.retryAt > now).map(row => row.retryAt);
  const status = stopped
    ? 'stopped'
    : !rows.length
      ? 'empty'
      : rows.every(row => row.state === 'integrated')
        ? 'integrated'
        : quota.length
          ? 'waiting_quota'
          : counts.running || counts.integrating || counts.verifying
            ? 'busy' // Owned by another process, or an interrupted integration awaits its lease expiry.
            : counts.queued || counts.waiting_quota
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
 * Build the keeper of one lease: renew it on a timer, stop the work as soon as
 * ownership is gone, and register a late-renewal hook in `leases`.
 * @param {{ jobs: JobQueueOptions['jobs'], leases: Map<string, () => void>, ttlMs: number, heartbeatMs: number, now: () => number, signal?: AbortSignal }} context
 */
function leaseGuard({ jobs, leases, ttlMs, heartbeatMs, now, signal }) {
  return (job, token) => {
    const controller = new AbortController();
    const owned = () => {
      try {
        return jobs.heartbeat(job.id, token, { ttlMs }).ok;
      } catch {
        return false;
      }
    };
    let renewed = now();
    const beat = () => {
      if (owned()) renewed = now();
      else controller.abort();
    };
    const timer = setInterval(beat, heartbeatMs);
    timer.unref();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    // Renewal on dispatch covers a late timer only; every beat is a SQLite commit.
    leases.set(token, () => {
      if (now() - renewed >= ttlMs / 3) beat();
    });
    return {
      signal: controller.signal,
      confirmOwnership() {
        if (!owned()) {
          controller.abort();
          throw fail('lease_lost', `ownership of ${job.key} is gone`);
        }
      },
      end() {
        clearInterval(timer);
        signal?.removeEventListener('abort', stop);
        leases.delete(token);
      },
    };
  };
}

/**
 * Drive a queue until nothing more can start or integrate from this process.
 * Resolves with a summary; rejects only for an integration whose outcome is
 * unknown (the job stays `integrating` for reconciliation), an integration
 * that finished after its ownership was taken over, or a broken port.
 * @param {JobQueueOptions} options
 */
export async function runJobQueue(options) {
  const { jobs, queue, owner, limits, hosts, worker, execute, integrate, reconcile, signal } = options;
  const ttlMs = options.ttlMs ?? 60000,
    heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(ttlMs / 3)),
    now = options.now ?? Date.now;
  /** Leases this process holds, by lease token: execution and integration alike. */
  const leases = new Map();
  let executing = 0,
    integrating = false,
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
  const guard = leaseGuard({ jobs, leases, ttlMs, heartbeatMs, now, signal });

  function succeeded(job, token, result) {
    try {
      jobs.complete(job.id, token, result ?? {});
    } catch (error) {
      if (!rejected(error)) throw error;
      // An unusable result is this job's failure, not a reason to stop the queue.
      jobs.fail(job.id, token, { reason: `result_rejected:${error.code}`, retryable: false });
    }
  }

  function failed(job, token, error) {
    if (signal?.aborted) return jobs.release(job.id, token, { reason: 'stopped' });
    if (error?.handBack === true) return jobs.release(job.id, token, { reason: 'handed_back' });
    if (error?.code !== 'quota')
      return jobs.fail(job.id, token, { reason: error?.message, retryable: error?.retryable !== false });
    const pause = extra => jobs.waitQuota(job.id, token, { retryAt: retryTime(error, now()), ...extra });
    try {
      return pause({ reason: error.message, ...(error.checkpoint ? { checkpoint: error.checkpoint } : {}) });
    } catch (refused) {
      if (!rejected(refused)) throw refused;
      return pause({ reason: 'checkpoint_rejected' });
    }
  }

  function start({ job, token }) {
    const lease = guard(job, token);
    executing++;
    Promise.resolve()
      .then(() => execute(job, { signal: lease.signal }))
      .then(
        result => report(() => succeeded(job, token, result)),
        error => report(() => failed(job, token, error)),
      )
      .finally(() => {
        lease.end();
        executing--;
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
        receipt = await integrate(job, { signal: lease.signal, confirmOwnership: lease.confirmOwnership });
      } catch (error) {
        // Only a confirmed absence may be retried; anything else stays owned for reconciliation.
        if (error?.integrated !== false) throw error;
        jobs.abortIntegration(job.id, token, { reason: error.message, retry: error.retryable !== false });
        return;
      }
      try {
        jobs.finishIntegration(job.id, token, receipt ?? {});
      } catch (error) {
        // The port integrated, but another owner took the job over meanwhile.
        if (leaseLost(error))
          throw fail('integration_ownership_lost', `${job.key} was integrated after its lease was taken over`);
        throw error;
      }
    } finally {
      lease.end();
    }
  }

  function dispatch() {
    // Renew before every sweep: a stalled event loop or slow commits must not
    // hand our own live jobs out again.
    const renewLate = () => {
      for (const renewIfLate of leases.values()) renewIfLate();
    };
    renewLate();
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
    while (!options.paused?.() && executing < limits.workers) {
      renewLate();
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
      if (!executing && !integrating) {
        if (fatal) throw fatal;
        return summarize(jobs, queue, { stopped: Boolean(signal?.aborted), waiting, now: now() });
      }
      await new Promise(resolve => {
        wake = resolve;
      });
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
