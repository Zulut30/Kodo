/** Operation journal of delivery: one durable record before each irreversible
 * remote effect (pull request, merge, release) and one after the remote state
 * was read back. An intent without an outcome means the effect is uncertain:
 * it may or may not have happened. Delivery never repeats such an effect
 * blindly; it reads the remote state first. The journal is append-only run
 * events, so it survives a crash at any point and changes no saved receipt.
 */

export const OPERATION_EVENT = 'delivery.operation';
export const DELIVERY_OPERATIONS = Object.freeze(['pr', 'merge', 'release']);
/**
 * `confirmed`: this call performed the effect and it is visible (a PR is confirmed by the URL the
 * command returned; a merge and a release by reading the remote state back).
 * `reconciled`: found by read-back alone; this call did not perform it.
 * `absent`: the command failed and read-back shows the effect did not happen.
 * Anything less certain has no outcome and stays `uncertain`.
 */
const outcomes = new Set(['confirmed', 'reconciled', 'absent']);

/**
 * Record that a remote effect is about to start.
 * @param {{ event: (type: string, data: object) => any }} ctx
 * @param {'pr' | 'merge' | 'release'} operation
 * @param {Record<string, any>} [data] Identifiers only: numbers, tags and commit ids.
 */
export async function operationIntent(ctx, operation, data = {}) {
  await ctx.event(OPERATION_EVENT, { ...data, operation, phase: 'intent' });
}

/**
 * Record what reading the remote state back showed. The journal observes:
 * a failure to write an outcome never fails a delivery whose remote effect and
 * saved receipt already exist. (An intent is different: it must be durable
 * before the effect, so its failure does stop the effect.)
 * @param {{ event: (type: string, data: object) => any }} ctx
 * @param {'pr' | 'merge' | 'release'} operation
 * @param {'confirmed' | 'reconciled' | 'absent'} status
 * @param {Record<string, any>} [data]
 */
export async function operationOutcome(ctx, operation, status, data = {}) {
  try {
    await ctx.event(OPERATION_EVENT, { ...data, operation, phase: 'outcome', status });
  } catch {
    /* The operation stays `uncertain` in the journal; the next delivery reads the remote state anyway. */
  }
}

/**
 * Reduce run events to the latest state of each remote operation.
 * @param {{ type?: string, data?: any, time?: number }[]} events
 * @returns {{ operation: string, status: 'uncertain' | 'confirmed' | 'reconciled' | 'absent', attempts: number,
 *   intentAt: number | null, outcomeAt: number | null, details: Record<string, any> }[]}
 */
export function deliveryOperations(events) {
  const state = new Map();
  for (const event of events || []) {
    if (event?.type !== OPERATION_EVENT || !DELIVERY_OPERATIONS.includes(event.data?.operation)) continue;
    const { operation, phase, status, ...details } = event.data;
    const previous = state.get(operation);
    if (phase === 'intent')
      state.set(operation, {
        operation,
        status: 'uncertain',
        attempts: (previous?.attempts ?? 0) + 1,
        intentAt: event.time ?? null,
        outcomeAt: null,
        details,
      });
    else if (phase === 'outcome' && outcomes.has(status)) {
      // A later read-back of an effect this run itself confirmed does not turn it into `reconciled`.
      if (previous?.status === 'confirmed' && status === 'reconciled') continue;
      state.set(operation, {
        operation,
        status,
        attempts: previous?.attempts ?? 0,
        intentAt: previous?.intentAt ?? null,
        outcomeAt: event.time ?? null,
        details: { ...previous?.details, ...details },
      });
    }
  }
  return DELIVERY_OPERATIONS.filter(operation => state.has(operation)).map(operation => state.get(operation));
}

/** Operations whose remote effect was started and never read back. */
export const uncertainOperations = events =>
  deliveryOperations(events)
    .filter(item => item.status === 'uncertain')
    .map(item => item.operation);

/**
 * Deployment is reported honestly: without a configured target nothing is
 * deployed and nothing passes. This version has no deployment adapter, so
 * configured commands are reported as not run rather than executed silently.
 * @param {{ commands?: { deploy?: unknown[] } }} config
 */
export function deploymentStatus(config) {
  return Array.isArray(config?.commands?.deploy) && config.commands.deploy.length
    ? { status: 'not_run', reason: 'no_deployment_adapter', passed: null }
    : { status: 'not_configured', passed: null };
}
