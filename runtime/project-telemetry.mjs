/* oxlint-disable max-lines -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md */
/**
 * Project-level operational KPIs for `kodo report --project` (16C):
 * throughput, taskDuration (p50/p95), time breakdown (agent, task-fast,
 * integration queue wait/merge, gates verify/review/repair, quota, human),
 * firstPassYield, arbitrations, interventions and resource utilization.
 *
 * Pure: no clock, file, database, network or provider access.
 * Every duration comes strictly from recorded timestamps; missing or open
 * boundaries yield `null` with `complete: false` and are never fabricated.
 */

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const duration = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const integer = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const code = (value, fallback = 'unknown') =>
  typeof value === 'string' && /^[A-Za-z][\w.:-]{0,63}$/.test(value) ? value : fallback;
const token = value => (typeof value === 'string' && /^[\w.:+/@-]{1,128}$/.test(value) ? value : null);

function millis(value) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}
const iso = value => {
  const parsed = millis(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};
const interval = (start, end) => (start !== null && end !== null && end >= start ? end - start : null);
const round4 = value => Math.round(value * 10000) / 10000;

function orderedEvents(events) {
  return list(events)
    .filter(record)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (integer(a.event.seq) ?? a.index) - (integer(b.event.seq) ?? b.index))
    .map(item => item.event);
}

/** Nearest-rank percentile on a non-empty array of finite numbers. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function summarizeBucket(samples, { allowZero = false, missing = false, withPercentiles = false } = {}) {
  const known = samples.filter(value => value !== null);
  const measuredMs = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  const total = samples.length;
  const complete = !missing && (total === 0 ? allowZero : known.length === total);
  const durationMs = complete ? (measuredMs ?? 0) : null;
  if (!withPercentiles) return { durationMs, measuredMs, known: known.length, total, complete };
  return {
    durationMs,
    measuredMs,
    p50Ms: complete && known.length > 0 ? percentile(known, 0.5) : null,
    p95Ms: complete && known.length > 0 ? percentile(known, 0.95) : null,
    known: known.length,
    total,
    complete,
  };
}

const integratedStatuses = new Set(['integrated', 'accepted', 'released']);
const acceptedStatuses = new Set(['accepted', 'released']);
const stoppedAttemptStatuses = new Set(['blocked', 'failed', 'cancelled']);
const closedTaskStatuses = new Set(['integrated', 'accepted', 'released', 'cancelled']);
const untouchedTaskStatuses = new Set(['proposed', 'ready', 'cancelled']);
const terminalQueueStatuses = new Set(['integrated', 'rejected', 'failed']);
const terminalGateStates = new Set(['succeeded', 'blocked', 'failed', 'cancelled']);
const nonVerdictTaskFastCodes = new Set([
  'run_busy',
  'project_lease_lost',
  'project_task_busy',
  'cancelled',
  'aborted',
]);
const isAbortedTaskFast = ev =>
  ev?.data?.skipped === true ||
  ev?.data?.outcome === 'aborted' ||
  ev?.data?.outcome === 'cancelled' ||
  nonVerdictTaskFastCodes.has(ev?.data?.code);
const isCompletedTaskFastVerdict = ev =>
  ev?.type === 'task_fast_finished' &&
  !isAbortedTaskFast(ev) &&
  (ev?.data?.outcome === 'passed' ||
    ev?.data?.outcome === 'failed' ||
    (ev?.data?.outcome === undefined && typeof ev?.data?.passed === 'boolean'));

const lookup = (source, id) =>
  source instanceof Map ? source.get(id) : record(source) && Object.hasOwn(source, id) ? source[id] : undefined;

function issuedAtOf(attempt, run, events) {
  const brief = events.find(event => event.type === 'brief_issued');
  if (brief) {
    const t = millis(brief.time);
    if (t !== null) return t;
  }
  const fromAttempt = millis(attempt?.createdAt);
  if (fromAttempt !== null) return fromAttempt;
  const fromRun = millis(run?.createdAt);
  if (fromRun !== null) return fromRun;
  const created = events.find(event => event.type === 'created');
  return created ? millis(created.time) : null;
}

function integratedAtOf(run, events, queueRows) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'integration_finished' && event.data?.status === 'integrated') {
      const t = millis(event.time);
      if (t !== null) return t;
    }
  }
  for (let i = queueRows.length - 1; i >= 0; i--) {
    const row = queueRows[i];
    if (row.status === 'integrated') {
      const t = millis(row.outcome?.finishedAt) ?? millis(row.updatedAt);
      if (t !== null) return t;
    }
  }
  const fromCompletion = millis(run?.externalCompletion?.integratedAt);
  if (fromCompletion !== null) return fromCompletion;
  return millis(run?.integration?.mergedAt);
}

function stoppedAtOf(attempt, run, events, queueRows) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.type === 'cancelled' ||
      event.type === 'blocked' ||
      (event.type === 'integration_finished' && ['rejected', 'failed'].includes(event.data?.status))
    ) {
      const t = millis(event.time);
      if (t !== null) return t;
    }
  }
  for (let i = queueRows.length - 1; i >= 0; i--) {
    const row = queueRows[i];
    if (['rejected', 'failed'].includes(row.status)) {
      const t = millis(row.outcome?.finishedAt) ?? millis(row.updatedAt);
      if (t !== null) return t;
    }
  }
  if (stoppedAttemptStatuses.has(attempt?.status)) return millis(attempt?.updatedAt);
  return null;
}

function pairStartFinish(events, startType, finishType, { ignoreFinish = null } = {}) {
  const samples = [];
  let open = null;
  for (const event of events) {
    if (event.type === startType) {
      if (open !== null) samples.push(null);
      open = millis(event.time);
      if (open === null) open = NaN;
    } else if (event.type === finishType && open !== null) {
      if (!ignoreFinish || !ignoreFinish(event)) {
        samples.push(Number.isNaN(open) ? null : interval(open, millis(event.time)));
      }
      open = null;
    }
  }
  if (open !== null) samples.push(null);
  return samples;
}

function queueEntriesOf(attempts, eventsByRun, integrationQueue) {
  /** @type {Map<string, { runId: string, seq: number | null, status: string | null, enqueuedMs: number | null, dequeuedMs: number | null, finishedMs: number | null }>} */
  const byKey = new Map();
  const keyOf = (runId, seq, fallbackIndex) => `${runId}:${seq ?? `e${fallbackIndex}`}`;

  for (const [index, row] of list(integrationQueue).filter(record).entries()) {
    const runId = typeof row.runId === 'string' ? row.runId : '';
    const seq = integer(row.seq);
    const key = keyOf(runId, seq, index);
    byKey.set(key, {
      runId,
      seq,
      status: typeof row.status === 'string' ? row.status : null,
      enqueuedMs: millis(row.enqueuedAt),
      dequeuedMs: millis(row.outcome?.dequeuedAt),
      finishedMs: terminalQueueStatuses.has(row.status)
        ? (millis(row.outcome?.finishedAt) ?? millis(row.updatedAt))
        : null,
    });
  }

  for (const item of attempts) {
    if (typeof item.runId !== 'string') continue;
    const events = orderedEvents(lookup(eventsByRun, item.runId));
    let synthetic = 0;
    for (const event of events) {
      if (!['integration_enqueued', 'integration_dequeued', 'integration_finished'].includes(event.type)) continue;
      const seq = integer(event.data?.seq);
      const key = keyOf(item.runId, seq, synthetic);
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          runId: item.runId,
          seq,
          status: null,
          enqueuedMs: null,
          dequeuedMs: null,
          finishedMs: null,
        };
        byKey.set(key, entry);
      }
      const t = millis(event.time);
      if (event.type === 'integration_enqueued' && entry.enqueuedMs === null) entry.enqueuedMs = t;
      else if (event.type === 'integration_dequeued' && entry.dequeuedMs === null) entry.dequeuedMs = t;
      else if (event.type === 'integration_finished') {
        if (entry.finishedMs === null) entry.finishedMs = t;
        if (entry.status === null && typeof event.data?.status === 'string') entry.status = event.data.status;
        if (seq === null) synthetic++;
      }
    }
  }
  return [...byKey.values()];
}

function agentSampleForAttempt(attempt, run, events) {
  if (!record(run)) return null;
  if (run.executor?.kind === 'external') {
    const brief = events.find(event => event.type === 'brief_issued');
    const issued = brief ? millis(brief.time) : null;
    if (issued === null) return null;
    const submissions = events.filter(event => event.type === 'task_submitted');
    if (!submissions.length) {
      if (record(run.externalAbandon) || run.state === 'cancelled') {
        const cancelEvent = events.findLast(event => event.type === 'cancelled');
        return interval(issued, cancelEvent ? millis(cancelEvent.time) : null);
      }
      return null;
    }
    const fastEnds = events.filter(event => isCompletedTaskFastVerdict(event));
    let sum = 0;
    for (let i = 0; i < submissions.length; i++) {
      const subTime = millis(submissions[i].time);
      if (subTime === null) return null;
      let start;
      if (i === 0) {
        start = issued;
      } else {
        const prevSub = submissions[i - 1];
        const prevSubTime = millis(prevSub.time);
        if (prevSubTime === null) return null;
        if (prevSub.data?.accepted === false) {
          start = prevSubTime;
        } else {
          const prevFast = fastEnds.findLast(ev => {
            const t = millis(ev.time);
            return t !== null && t >= prevSubTime && t <= subTime;
          });
          start = prevFast ? millis(prevFast.time) : null;
        }
      }
      const seg = interval(start, subTime);
      if (seg === null) return null;
      sum += seg;
    }
    const lastSub = submissions.at(-1);
    const lastSubTime = millis(lastSub.time);
    const lastFastAfter = fastEnds.findLast(ev => {
      const t = millis(ev.time);
      return t !== null && lastSubTime !== null && t >= lastSubTime;
    });
    const returnedToAgentAt =
      lastSub.data?.accepted === false
        ? lastSubTime
        : lastFastAfter && lastFastAfter.data?.passed !== true
          ? millis(lastFastAfter.time)
          : null;
    if (returnedToAgentAt !== null) {
      if (record(run.externalAbandon) || run.state === 'cancelled') {
        const cancelEvent = events.findLast(event => event.type === 'cancelled');
        const tail = interval(returnedToAgentAt, cancelEvent ? millis(cancelEvent.time) : null);
        return tail === null ? null : sum + tail;
      }
      if (run.state === 'executing') return null;
    }
    return sum;
  }
  // Native attempt: sum implementation sessions if history is complete.
  if (run.metrics?.historyComplete === false || !Array.isArray(run.sessionAttempts)) return null;
  const impl = run.sessionAttempts.filter(item => ['developer', 'tester', 'documenter'].includes(item?.stage));
  if (!impl.length) return null;
  const durations = impl.map(item => duration(item?.metrics?.durationMs));
  if (durations.some(value => value === null)) return null;
  return durations.reduce((a, b) => a + b, 0);
}

function taskFastSamplesForAttempt(run, events) {
  if (!record(run)) return [null];
  const paired = pairStartFinish(events, 'task_fast_started', 'task_fast_finished', {
    ignoreFinish: isAbortedTaskFast,
  });
  const lastAcceptedSub = events.findLast(ev => ev.type === 'task_submitted' && ev.data?.accepted !== false);
  if (lastAcceptedSub && run.state === 'executing' && !record(run.externalAbandon)) {
    const subTime = millis(lastAcceptedSub.time);
    const hasVerdictAfter = events.some(
      ev =>
        isCompletedTaskFastVerdict(ev) && millis(ev.time) !== null && subTime !== null && millis(ev.time) >= subTime,
    );
    if (!hasVerdictAfter) paired.push(null);
  }
  if (paired.length) return paired;
  if (run.verificationProfile === 'task-fast' && (run.checks?.profile === 'task-fast' || run.state === 'succeeded')) {
    const rows = list(run.checks?.results).filter(record);
    if (rows.length && rows.every(row => duration(row.durationMs) !== null)) {
      return rows.map(row => duration(row.durationMs));
    }
    return [null];
  }
  return [];
}

function gateVerifySamples(run, events) {
  if (!record(run)) return [null];
  const verifyPairs = pairStartFinish(events, 'gate_verify_started', 'gate_verify_finished');
  const smokePairs = pairStartFinish(events, 'gate_smoke_started', 'gate_smoke_finished');
  if (verifyPairs.length || smokePairs.length) return [...verifyPairs, ...smokePairs];
  if (!terminalGateStates.has(run.state)) return [null];
  const samples = [];
  const checkStarts = events.filter(event => event.type === 'check_started');
  const checkRows = list(run.checks?.results).filter(record);
  if (checkStarts.length || checkRows.length) {
    const count = Math.max(checkStarts.length, checkRows.length);
    for (let i = 0; i < count; i++) samples.push(duration(checkRows[i]?.durationMs));
  }
  for (const row of list(run.smoke?.results).filter(record)) samples.push(duration(row.durationMs));
  if (!samples.length && run.state === 'succeeded') return [null];
  return samples;
}

function gateSessionSamples(run, stage) {
  if (!record(run)) return [null];
  if (!terminalGateStates.has(run.state)) return [null];
  if (run.metrics?.historyComplete === false || !Array.isArray(run.sessionAttempts)) return [null];
  return run.sessionAttempts.filter(item => item?.stage === stage).map(item => duration(item?.metrics?.durationMs));
}

function matchHistoryEntry(history, usedHistory, openTime, upperBound = null) {
  if (openTime === null || Number.isNaN(openTime)) return null;
  const idx = history.findIndex((item, index) => {
    if (usedHistory.has(index)) return false;
    const first = millis(item.firstSeen);
    const ended = millis(item.endedAt);
    if (first === null || ended === null || ended < openTime) return false;
    if (upperBound !== null && ended > upperBound) return false;
    const last = millis(item.lastSeen);
    return (
      Math.abs(first - openTime) <= 5000 ||
      (last !== null && Math.abs(last - openTime) <= 5000) ||
      (first <= openTime && openTime <= ended)
    );
  });
  if (idx < 0) return null;
  usedHistory.add(idx);
  return millis(history[idx].endedAt);
}

function quotaSamplesForRun(run, events) {
  if (!record(run)) return [];
  const samples = [];
  const history = list(run.blocker?.history).filter(item => record(item) && item.code === 'quota');
  const usedHistory = new Set();
  let openQuota = null;
  for (const event of events) {
    if (event.type === 'waiting_limits') {
      if (openQuota !== null) {
        const histEnd = matchHistoryEntry(history, usedHistory, openQuota, millis(event.time));
        samples.push(histEnd === null ? null : interval(openQuota, histEnd));
      }
      openQuota = millis(event.time);
      if (openQuota === null) openQuota = NaN;
    } else if ((event.type === 'resumed' || event.type === 'cancelled') && openQuota !== null) {
      samples.push(Number.isNaN(openQuota) ? null : interval(openQuota, millis(event.time)));
      openQuota = null;
    }
  }
  if (openQuota !== null) {
    const histEnd =
      run.state !== 'waiting_limits' && run.blocker?.current?.code !== 'quota'
        ? matchHistoryEntry(history, usedHistory, openQuota)
        : null;
    samples.push(histEnd === null ? null : interval(openQuota, histEnd));
  } else if (!events.some(event => event.type === 'waiting_limits')) {
    for (const item of history) samples.push(interval(millis(item.firstSeen), millis(item.endedAt)));
    if (run.state === 'waiting_limits' || run.blocker?.current?.code === 'quota') samples.push(null);
  }
  return samples;
}

function humanSamplesForRun(run, events, closedBySuccessorAt = null) {
  if (!record(run)) return [];
  const samples = [];
  const history = list(run.blocker?.history).filter(item => record(item) && item.code !== 'quota');
  const usedHistory = new Set();
  let openBlocked = null;
  for (const event of events) {
    if (event.type === 'blocked') {
      if (openBlocked !== null) {
        const histEnd = matchHistoryEntry(history, usedHistory, openBlocked, millis(event.time));
        samples.push(histEnd === null ? null : interval(openBlocked, histEnd));
      }
      openBlocked = millis(event.time);
      if (openBlocked === null) openBlocked = NaN;
    } else if ((event.type === 'resumed' || event.type === 'cancelled') && openBlocked !== null) {
      samples.push(Number.isNaN(openBlocked) ? null : interval(openBlocked, millis(event.time)));
      openBlocked = null;
    }
  }
  if (openBlocked !== null) {
    if (closedBySuccessorAt !== null && !Number.isNaN(openBlocked)) {
      samples.push(interval(openBlocked, closedBySuccessorAt));
    } else if (run.state !== 'blocked' && !(record(run.blocker?.current) && run.blocker.current.code !== 'quota')) {
      const histEnd = matchHistoryEntry(history, usedHistory, openBlocked);
      samples.push(histEnd === null ? null : interval(openBlocked, histEnd));
    } else {
      samples.push(null);
    }
  } else if (!events.some(event => event.type === 'blocked')) {
    for (const item of history) samples.push(interval(millis(item.firstSeen), millis(item.endedAt)));
    if (run.state === 'blocked' || (record(run.blocker?.current) && run.blocker.current.code !== 'quota')) {
      if (closedBySuccessorAt !== null && millis(run.blocker?.current?.firstSeen) !== null) {
        samples.push(interval(millis(run.blocker.current.firstSeen), closedBySuccessorAt));
      } else {
        samples.push(null);
      }
    }
  }
  return samples;
}

/**
 * Time-weighted median and peak concurrency of `[start, end]` intervals over `[windowStart, windowEnd]`.
 * @param {Array<[number, number]>} intervals
 * @param {number} windowStart
 * @param {number} windowEnd
 */
function weightedOccupancy(intervals, windowStart, windowEnd) {
  const totalDuration = windowEnd - windowStart;
  if (!(totalDuration > 0)) return { median: null, peak: null };
  const points = new Set([windowStart, windowEnd]);
  const clamped = [];
  for (const [start, end] of intervals) {
    const s = Math.max(windowStart, Math.min(windowEnd, start));
    const e = Math.max(windowStart, Math.min(windowEnd, end));
    if (e > s) {
      clamped.push([s, e]);
      points.add(s);
      points.add(e);
    }
  }
  const sortedPoints = [...points].sort((a, b) => a - b);
  /** @type {Map<number, number>} */
  const durationByCount = new Map();
  let peak = 0;
  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const a = sortedPoints[i],
      b = sortedPoints[i + 1];
    const dt = b - a;
    if (!(dt > 0)) continue;
    let count = 0;
    for (const [s, e] of clamped) if (s <= a && e >= b) count++;
    if (count > peak) peak = count;
    durationByCount.set(count, (durationByCount.get(count) ?? 0) + dt);
  }
  const buckets = [...durationByCount.entries()].sort((a, b) => a[0] - b[0]);
  const half = totalDuration / 2;
  let cumulative = 0;
  let median = null;
  for (let i = 0; i < buckets.length; i++) {
    const [count, dt] = buckets[i];
    cumulative += dt;
    if (cumulative > half) {
      median = count;
      break;
    }
    if (cumulative === half) {
      median = i + 1 < buckets.length ? (count + buckets[i + 1][0]) / 2 : count;
      break;
    }
  }
  return { median, peak };
}

function buildContext({
  snapshot,
  attempts,
  runsById,
  eventsByRun,
  integrationQueue,
  runsComplete,
  snapshotComplete = true,
}) {
  const tasks = list(snapshot.tasks).filter(record);
  const currentByTask = new Map(
    list(snapshot.currentAttempts)
      .filter(record)
      .map(item => [item.taskId, item]),
  );
  const queueByRun = new Map();
  for (const row of list(integrationQueue).filter(record)) {
    if (typeof row.runId !== 'string') continue;
    if (!queueByRun.has(row.runId)) queueByRun.set(row.runId, []);
    queueByRun.get(row.runId).push(row);
  }
  const enrichedAttempts = attempts.map(item => {
    const run = typeof item.runId === 'string' ? lookup(runsById, item.runId) : undefined;
    const events = typeof item.runId === 'string' ? orderedEvents(lookup(eventsByRun, item.runId)) : [];
    const qRows = typeof item.runId === 'string' ? (queueByRun.get(item.runId) ?? []) : [];
    return {
      attempt: item,
      run: record(run) ? run : null,
      events,
      queueRows: qRows,
      issuedMs: issuedAtOf(item, run, events),
      integratedMs: integratedAtOf(run, events, qRows),
      stoppedMs: stoppedAtOf(item, run, events, qRows),
    };
  });
  const enrichedByTask = new Map();
  for (const item of enrichedAttempts) {
    const id = item.attempt.taskId;
    if (!enrichedByTask.has(id)) enrichedByTask.set(id, []);
    enrichedByTask.get(id).push(item);
  }
  for (const group of enrichedByTask.values()) {
    group.sort((a, b) => (integer(a.attempt.number) ?? 0) - (integer(b.attempt.number) ?? 0));
  }
  const rawGates = list(snapshot.gates).filter(record);
  const activeGates = rawGates.filter(gate => !(gate.supersededBy !== undefined && gate.installed !== true));
  const gateEntries = activeGates.map(gate => {
    const runId = typeof gate.runId === 'string' ? gate.runId : null;
    const run = runId ? lookup(runsById, runId) : undefined;
    const events = runId ? orderedEvents(lookup(eventsByRun, runId)) : [];
    const key =
      Array.isArray(gate.containers) && record(gate.containers[0])
        ? `${code(gate.containers[0].kind)}:${gate.containers[0].id}`
        : null;
    return { gate, runId, run: record(run) ? run : null, events, key };
  });
  const hasAttemptGaps = tasks.some(task => {
    const own = enrichedByTask.get(task.id) ?? [];
    const current = currentByTask.get(task.id);
    const count = Math.max(
      integer(current?.number) ?? 0,
      ...own.map(item => integer(item.attempt.number) ?? 0),
      own.length,
    );
    return count > own.length || own.some((item, index) => (integer(item.attempt.number) ?? 0) !== index + 1);
  });
  const gatesComplete = gateEntries.every(item => item.run !== null);
  const snapshotCompletenessMissing =
    record(snapshot.completeness) &&
    Object.values(snapshot.completeness).some(entry => record(entry) && entry.complete !== true);
  const snapshotIncomplete = !snapshotComplete || snapshotCompletenessMissing;
  const queueEntries = queueEntriesOf(attempts, eventsByRun, integrationQueue);
  return {
    snapshot,
    tasks,
    currentByTask,
    enrichedAttempts,
    enrichedByTask,
    gateEntries,
    queueEntries,
    hasAttemptGaps,
    gatesComplete,
    snapshotIncomplete,
    missingTaskRuns: !runsComplete || hasAttemptGaps,
    missingAnyRuns: !runsComplete || hasAttemptGaps || !gatesComplete,
  };
}

function computeThroughputAndDuration(ctx) {
  const {
    tasks,
    currentByTask,
    enrichedAttempts,
    enrichedByTask,
    gateEntries,
    hasAttemptGaps,
    missingTaskRuns,
    missingAnyRuns,
    snapshotIncomplete,
  } = ctx;
  const acceptedAtByTask = new Map();
  for (const item of gateEntries) {
    for (const event of item.events) {
      if (event.type !== 'gate_accepted' || !Array.isArray(event.data?.taskIds)) continue;
      const t = millis(event.time);
      if (t === null) continue;
      for (const taskId of event.data.taskIds) {
        if (typeof taskId === 'string') acceptedAtByTask.set(taskId, t);
      }
    }
  }
  const allIssuedKnown =
    !snapshotIncomplete &&
    !missingTaskRuns &&
    enrichedAttempts.length > 0 &&
    !hasAttemptGaps &&
    enrichedAttempts.every(item => item.issuedMs !== null);
  const firstIssuedMs = allIssuedKnown ? Math.min(...enrichedAttempts.map(item => item.issuedMs)) : null;

  const integratedTasks = tasks.filter(task => integratedStatuses.has(task.status));
  const acceptedTasks = tasks.filter(task => acceptedStatuses.has(task.status));
  const integratedTimes = [];
  const taskDurationSamples = [];
  for (const task of integratedTasks) {
    const own = enrichedByTask.get(task.id) ?? [];
    const current = currentByTask.get(task.id);
    const count = Math.max(
      integer(current?.number) ?? 0,
      ...own.map(item => integer(item.attempt.number) ?? 0),
      own.length,
    );
    const taskComplete =
      own.length > 0 &&
      count === own.length &&
      own.every((item, index) => item.run !== null && (integer(item.attempt.number) ?? 0) === index + 1);
    const endMs = [...own].reverse().find(item => item.integratedMs !== null)?.integratedMs ?? null;
    integratedTimes.push(endMs);
    taskDurationSamples.push(interval(taskComplete ? own[0].issuedMs : null, endMs));
  }
  const acceptedTimes = acceptedTasks.map(task => {
    if (acceptedAtByTask.has(task.id)) return acceptedAtByTask.get(task.id);
    return task.status === 'accepted' ? millis(task.updatedAt) : null;
  });
  const buildRate = (count, endTimes, extraMissing = false) => {
    const knownEnds = endTimes.filter(value => value !== null);
    const endsComplete = !extraMissing && count > 0 && knownEnds.length === count;
    const windowEndMs = endsComplete ? Math.max(...knownEnds) : null;
    const windowMs = allIssuedKnown && endsComplete ? interval(firstIssuedMs, windowEndMs) : null;
    const complete = count > 0 && allIssuedKnown && endsComplete && windowMs !== null && windowMs > 0;
    return {
      tasksPerHour: complete ? round4((count * 3_600_000) / windowMs) : null,
      count,
      windowStart: allIssuedKnown ? iso(firstIssuedMs) : null,
      windowEnd: endsComplete ? iso(windowEndMs) : null,
      windowMs,
      known: knownEnds.length,
      total: count,
      complete,
    };
  };
  const knownDurations = taskDurationSamples.filter(value => value !== null);
  const durationComplete =
    !snapshotIncomplete &&
    !missingTaskRuns &&
    integratedTasks.length > 0 &&
    knownDurations.length === integratedTasks.length;
  return {
    throughput: {
      integrated: buildRate(integratedTasks.length, integratedTimes, snapshotIncomplete || missingTaskRuns),
      accepted: buildRate(acceptedTasks.length, acceptedTimes, snapshotIncomplete || missingAnyRuns),
    },
    taskDuration: {
      p50Ms: durationComplete ? percentile(knownDurations, 0.5) : null,
      p95Ms: durationComplete ? percentile(knownDurations, 0.95) : null,
      known: knownDurations.length,
      total: integratedTasks.length,
      complete: durationComplete,
    },
  };
}

function collectHumanSamples(ctx) {
  const { snapshot, tasks, enrichedAttempts, enrichedByTask, gateEntries } = ctx;
  const humanSamples = [];
  const handledBlockedRuns = new Set();
  for (const task of tasks) {
    const own = enrichedByTask.get(task.id) ?? [];
    for (let i = 0; i < own.length; i++) {
      const item = own[i];
      const next = own[i + 1];
      const stopped =
        stoppedAttemptStatuses.has(item.attempt.status) ||
        record(item.run?.externalAbandon) ||
        item.run?.state === 'blocked' ||
        (item.run?.state === 'cancelled' && next !== undefined);
      if (stopped && next) {
        handledBlockedRuns.add(item.attempt.runId);
        humanSamples.push(interval(item.stoppedMs, next.issuedMs));
      } else if (stopped && !next && !closedTaskStatuses.has(task.status)) {
        handledBlockedRuns.add(item.attempt.runId);
        humanSamples.push(null);
      }
    }
  }
  for (const item of enrichedAttempts) {
    if (!handledBlockedRuns.has(item.attempt.runId)) humanSamples.push(...humanSamplesForRun(item.run, item.events));
  }
  for (const item of gateEntries) {
    const successor = gateEntries.find(
      other =>
        other.key !== null &&
        other.key === item.key &&
        (integer(other.gate.number) ?? 0) > (integer(item.gate.number) ?? 0),
    );
    const successorAt = successor ? (millis(successor.gate.createdAt) ?? millis(successor.run?.createdAt)) : null;
    humanSamples.push(...humanSamplesForRun(item.run, item.events, successorAt));
  }
  if (snapshot.project.paused === true) humanSamples.push(null);
  return humanSamples;
}

function computeBreakdown(ctx) {
  const {
    enrichedAttempts,
    gateEntries,
    queueEntries,
    gatesComplete,
    missingTaskRuns,
    missingAnyRuns,
    snapshotIncomplete,
  } = ctx;
  const taskMissing = missingTaskRuns || snapshotIncomplete;
  const gateMissing = !gatesComplete || snapshotIncomplete;
  const anyMissing = missingAnyRuns || snapshotIncomplete;
  const agentSamples = enrichedAttempts.map(item => agentSampleForAttempt(item.attempt, item.run, item.events));
  const taskFastSamples = enrichedAttempts.flatMap(item => taskFastSamplesForAttempt(item.run, item.events));
  const queueRunIds = new Set(queueEntries.map(entry => entry.runId));
  const waitSamples = queueEntries.map(entry => interval(entry.enqueuedMs, entry.dequeuedMs));
  const mergeSamples = queueEntries.map(entry => interval(entry.dequeuedMs, entry.finishedMs));
  for (const item of enrichedAttempts) {
    if (
      item.run?.executor?.kind === 'external' &&
      (item.run.externalCompletion || integratedStatuses.has(item.attempt.status)) &&
      !queueRunIds.has(item.run.id)
    ) {
      waitSamples.push(null);
      mergeSamples.push(null);
    }
  }
  const quotaSamples = [
    ...enrichedAttempts.flatMap(item => quotaSamplesForRun(item.run, item.events)),
    ...gateEntries.flatMap(item => quotaSamplesForRun(item.run, item.events)),
  ];
  return {
    agent: summarizeBucket(agentSamples, { allowZero: false, missing: taskMissing }),
    taskFast: summarizeBucket(taskFastSamples, { allowZero: false, missing: taskMissing }),
    integrationQueue: {
      wait: summarizeBucket(waitSamples, { allowZero: false, missing: taskMissing, withPercentiles: true }),
      merge: summarizeBucket(mergeSamples, { allowZero: false, missing: taskMissing, withPercentiles: true }),
    },
    gates: {
      verify: summarizeBucket(
        gateEntries.flatMap(item => gateVerifySamples(item.run, item.events)),
        { allowZero: false, missing: gateMissing },
      ),
      review: summarizeBucket(
        gateEntries.flatMap(item => gateSessionSamples(item.run, 'review')),
        { allowZero: false, missing: gateMissing },
      ),
      repair: summarizeBucket(
        gateEntries.flatMap(item => gateSessionSamples(item.run, 'repair')),
        { allowZero: gateEntries.length > 0, missing: gateMissing },
      ),
    },
    quota: summarizeBucket(quotaSamples, { allowZero: true, missing: anyMissing }),
    human: summarizeBucket(collectHumanSamples(ctx), { allowZero: true, missing: anyMissing }),
  };
}

function computeFirstPassYield(ctx) {
  const { tasks, currentByTask, enrichedByTask, gateEntries, missingTaskRuns, snapshotIncomplete } = ctx;
  let taskPassed = 0,
    taskKnown = 0,
    taskTotal = 0;
  for (const task of tasks) {
    const own = enrichedByTask.get(task.id) ?? [];
    const current = currentByTask.get(task.id);
    const attemptCount = Math.max(
      integer(current?.number) ?? 0,
      ...own.map(item => integer(item.attempt.number) ?? 0),
      own.length,
    );
    if (attemptCount === 0 && untouchedTaskStatuses.has(task.status)) continue;
    taskTotal++;
    const first = own[0];
    if (!first || (integer(first.attempt.number) ?? 0) !== 1 || !first.run) continue;
    const subs = first.events.filter(ev => ev.type === 'task_submitted');
    const fasts = first.events.filter(ev => isCompletedTaskFastVerdict(ev));
    if (subs.length && subs[0].data?.accepted === false) {
      taskKnown++;
    } else if (fasts.length) {
      taskKnown++;
      if (fasts[0].data?.passed === true) taskPassed++;
    } else if (record(first.run.externalAbandon) || stoppedAttemptStatuses.has(first.attempt.status)) {
      taskKnown++;
    }
  }
  const taskComplete = !snapshotIncomplete && !missingTaskRuns && taskTotal > 0 && taskKnown === taskTotal;

  let gatePassed = 0,
    gateKnown = 0;
  const gateTotal = gateEntries.length;
  for (const item of gateEntries) {
    if (!item.run || !terminalGateStates.has(item.run.state)) continue;
    if (item.run.state !== 'succeeded') {
      gateKnown++;
      continue;
    }
    if (item.run.metrics?.historyComplete === false || !Array.isArray(item.run.sessionAttempts)) continue;
    gateKnown++;
    const repairRounds = item.events.filter(ev => ev.type === 'repair_required').length;
    const repairSessions = item.run.sessionAttempts.filter(s => s?.stage === 'repair').length;
    const headMoved =
      typeof item.gate.headSha === 'string' &&
      typeof item.run.headSha === 'string' &&
      item.run.headSha !== item.gate.headSha;
    if (repairRounds === 0 && repairSessions === 0 && !headMoved) gatePassed++;
  }
  const gateComplete = !snapshotIncomplete && gateTotal > 0 && gateKnown === gateTotal;
  return {
    taskFast: {
      passed: taskPassed,
      known: taskKnown,
      total: taskTotal,
      rate: taskComplete ? round4(taskPassed / taskTotal) : null,
      complete: taskComplete,
    },
    gate: {
      passed: gatePassed,
      known: gateKnown,
      total: gateTotal,
      rate: gateComplete ? round4(gatePassed / gateTotal) : null,
      complete: gateComplete,
    },
  };
}

function computeArbitrations(ctx) {
  const complete = !ctx.missingAnyRuns && !ctx.snapshotIncomplete;
  const seenRuns = new Map();
  for (const item of ctx.enrichedAttempts) if (item.run) seenRuns.set(item.run.id, item.run);
  for (const item of ctx.gateEntries) if (item.run) seenRuns.set(item.run.id, item.run);
  let count = 0;
  /** @type {Record<string, number>} */
  const decisions = {};
  for (const run of seenRuns.values()) {
    const raw = run.gateArbitration;
    // Only a decided arbitration counts (16B1 writes `status: 'started'` before the session).
    const decided = entry =>
      record(entry) &&
      (entry.status === undefined || entry.status === 'decided') &&
      ['confirm_pass', 'confirm_defect', 'split_needed'].includes(entry.decision ?? entry.verdict);
    const entries = (Array.isArray(raw) ? raw : [raw]).filter(decided);
    for (const entry of entries) {
      count++;
      const decision = code(entry.decision ?? entry.verdict, 'unknown');
      decisions[decision] = (decisions[decision] ?? 0) + 1;
    }
  }
  return { count: complete ? count : null, decisions: complete ? decisions : {}, complete };
}

function computeInterventions(ctx) {
  const { enrichedAttempts, gateEntries, queueEntries, hasAttemptGaps, missingAnyRuns, snapshotIncomplete } = ctx;
  const incomplete = missingAnyRuns || snapshotIncomplete;
  let abandonCount = 0;
  let rejectionCount = 0;
  const rejectedQueueKeys = new Set();
  for (const [index, entry] of queueEntries.entries()) {
    if (entry.status !== 'rejected') continue;
    const k = `${entry.runId}:${entry.seq ?? `e${index}`}`;
    if (!rejectedQueueKeys.has(k)) {
      rejectedQueueKeys.add(k);
      rejectionCount++;
    }
  }
  for (const item of enrichedAttempts) {
    if (!item.run) continue;
    const abandoned =
      record(item.run.externalAbandon) ||
      item.run.error?.code === 'external_abandoned' ||
      item.events.some(ev => ev.type === 'cancelled' && ev.data?.code === 'external_abandoned');
    if (abandoned) abandonCount++;
    const subRejects = item.events.filter(ev => ev.type === 'task_submitted' && ev.data?.accepted === false).length;
    const fastRejects = item.events.filter(ev => isCompletedTaskFastVerdict(ev) && ev.data?.passed === false).length;
    const runQueueRejects = [...rejectedQueueKeys].filter(k => k.startsWith(`${item.run.id}:`)).length;
    rejectionCount += subRejects + fastRejects;
    if (
      subRejects === 0 &&
      fastRejects === 0 &&
      runQueueRejects === 0 &&
      !abandoned &&
      ['blocked', 'failed'].includes(item.run.state)
    ) {
      rejectionCount++;
    }
  }
  for (const item of gateEntries) {
    if (item.run && ['blocked', 'failed'].includes(item.run.state)) rejectionCount++;
  }
  const taskRetries = enrichedAttempts.filter(item => (integer(item.attempt.number) ?? 1) > 1).length;
  const seenGateContainers = new Set();
  let gateRetries = 0;
  for (const item of gateEntries) {
    if (!item.key) continue;
    if (seenGateContainers.has(item.key)) gateRetries++;
    else seenGateContainers.add(item.key);
  }
  const retryFailedCount = hasAttemptGaps || incomplete ? null : taskRetries + gateRetries;
  const complete = !incomplete && retryFailedCount !== null;
  return {
    abandon: incomplete ? null : abandonCount,
    retryFailed: retryFailedCount,
    rejections: incomplete ? null : rejectionCount,
    total: complete ? abandonCount + retryFailedCount + rejectionCount : null,
    complete,
  };
}

function resourceMetadata(profile, slotIntervals) {
  const profileSubs = list(profile?.subscriptions).filter(record);
  const profileMachines = list(profile?.machines).filter(record);
  const capacity =
    profileSubs.length && profileMachines.length
      ? Math.min(
          profileSubs.reduce((sum, row) => sum + (integer(row.slots) ?? 0), 0),
          profileMachines.reduce((sum, row) => sum + (integer(row.maxWorkers) ?? 0), 0),
        )
      : null;
  const subMeta = new Map();
  for (const row of profileSubs) {
    const id = token(row.id);
    if (id)
      subMeta.set(id, {
        id,
        provider: token(row.provider),
        model: token(row.model),
        tier: token(row.tier),
        slots: integer(row.slots),
      });
  }
  const machineMeta = new Map();
  for (const row of profileMachines) {
    const id = token(row.id);
    if (id)
      machineMeta.set(id, {
        id,
        kind: token(row.kind),
        maxWorkers: integer(row.maxWorkers),
        maxHeavyBuilds: integer(row.maxHeavyBuilds),
      });
  }
  for (const item of slotIntervals) {
    if (item.subscriptionId && !subMeta.has(item.subscriptionId)) {
      subMeta.set(item.subscriptionId, {
        id: item.subscriptionId,
        provider: token(item.subscription?.provider),
        model: token(item.subscription?.model),
        tier: token(item.subscription?.tier),
        slots: null,
      });
    }
    if (item.machineId && !machineMeta.has(item.machineId)) {
      machineMeta.set(item.machineId, {
        id: item.machineId,
        kind: token(item.machine?.kind),
        maxWorkers: null,
        maxHeavyBuilds: null,
      });
    }
  }
  return { capacity, subMeta, machineMeta };
}

function computeUtilization(ctx, profile) {
  const { enrichedAttempts, missingTaskRuns, snapshotIncomplete } = ctx;
  const slotIntervals = enrichedAttempts.map(item => {
    const stopped =
      stoppedAttemptStatuses.has(item.attempt.status) ||
      record(item.run?.externalAbandon) ||
      ['cancelled', 'blocked', 'failed'].includes(item.run?.state);
    const endMs = item.integratedMs ?? (stopped ? item.stoppedMs : null);
    return {
      start: item.issuedMs,
      end: endMs,
      valid: interval(item.issuedMs, endMs) !== null,
      subscriptionId: token(item.run?.workerPlacement?.subscription?.id),
      machineId: token(item.run?.workerPlacement?.machine?.id),
      subscription: item.run?.workerPlacement?.subscription ?? null,
      machine: item.run?.workerPlacement?.machine ?? null,
    };
  });
  const knownSlots = slotIntervals.filter(item => item.valid);
  const allSlotsKnown =
    !snapshotIncomplete && !missingTaskRuns && slotIntervals.length > 0 && knownSlots.length === slotIntervals.length;
  const utilStart = allSlotsKnown ? Math.min(...knownSlots.map(item => item.start)) : null;
  const utilEnd = allSlotsKnown ? Math.max(...knownSlots.map(item => item.end)) : null;
  const utilWindowMs = allSlotsKnown ? interval(utilStart, utilEnd) : null;
  const utilComplete = allSlotsKnown && utilWindowMs !== null && utilWindowMs > 0;
  const overallOcc = utilComplete
    ? weightedOccupancy(
        knownSlots.map(item => [item.start, item.end]),
        utilStart,
        utilEnd,
      )
    : { median: null, peak: null };
  const { capacity, subMeta, machineMeta } = resourceMetadata(profile, slotIntervals);
  const allSubPlaced = slotIntervals.every(item => item.subscriptionId !== null);
  const allMachinePlaced = slotIntervals.every(item => item.machineId !== null);
  const mapRows = (metaMap, key, allPlaced) =>
    [...metaMap.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(meta => {
        const complete = utilComplete && allPlaced;
        const occ = complete
          ? weightedOccupancy(
              knownSlots.filter(item => item[key] === meta.id).map(item => [item.start, item.end]),
              utilStart,
              utilEnd,
            )
          : { median: null, peak: null };
        return { ...meta, median: occ.median, peak: occ.peak, complete };
      });
  return {
    overall: {
      median: overallOcc.median,
      peak: overallOcc.peak,
      capacity,
      windowMs: utilWindowMs,
      known: knownSlots.length,
      total: slotIntervals.length,
      complete: utilComplete,
    },
    subscriptions: mapRows(subMeta, 'subscriptionId', allSubPlaced),
    machines: mapRows(machineMeta, 'machineId', allMachinePlaced),
  };
}

/**
 * Compute C1 project telemetry fields from already-loaded state.
 * @param {{
 *   snapshot: any,
 *   attempts: any[],
 *   runsById: Map<string, any> | Record<string, any>,
 *   eventsByRun: Map<string, any[]> | Record<string, any[]>,
 *   integrationQueue?: any[],
 *   profile?: any,
 *   waveGates?: any[] | null,
 *   runsComplete: boolean,
 *   snapshotComplete?: boolean,
 * }} input
 */
export function buildProjectTelemetry({
  snapshot,
  attempts,
  runsById,
  eventsByRun,
  integrationQueue = [],
  profile = null,
  waveGates = null,
  runsComplete,
  snapshotComplete = true,
}) {
  void waveGates;
  const ctx = buildContext({
    snapshot,
    attempts,
    runsById,
    eventsByRun,
    integrationQueue,
    runsComplete,
    snapshotComplete,
  });
  const { throughput, taskDuration } = computeThroughputAndDuration(ctx);
  return {
    throughput,
    taskDuration,
    breakdown: computeBreakdown(ctx),
    firstPassYield: computeFirstPassYield(ctx),
    arbitrations: computeArbitrations(ctx),
    interventions: computeInterventions(ctx),
    utilization: computeUtilization(ctx, profile),
  };
}
