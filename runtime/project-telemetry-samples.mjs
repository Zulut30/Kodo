export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const list = value => (Array.isArray(value) ? value : []);
const duration = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
export const integer = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
export const code = (value, fallback = 'unknown') =>
  typeof value === 'string' && /^[A-Za-z][\w.:-]{0,63}$/.test(value) ? value : fallback;
export const token = value => (typeof value === 'string' && /^[\w.:+/@-]{1,128}$/.test(value) ? value : null);

export function millis(value) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}
export const iso = value => {
  const parsed = millis(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};
export const interval = (start, end) => (start !== null && end !== null && end >= start ? end - start : null);
export const round4 = value => Math.round(value * 10000) / 10000;

export function orderedEvents(events) {
  return list(events)
    .filter(record)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (integer(a.event.seq) ?? a.index) - (integer(b.event.seq) ?? b.index))
    .map(item => item.event);
}

/** Nearest-rank percentile on a non-empty array of finite numbers. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

export function summarizeBucket(samples, { allowZero = false, missing = false, withPercentiles = false } = {}) {
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

export const integratedStatuses = new Set(['integrated', 'accepted', 'released']);
export const acceptedStatuses = new Set(['accepted', 'released']);
export const stoppedAttemptStatuses = new Set(['blocked', 'failed', 'cancelled']);
export const closedTaskStatuses = new Set(['integrated', 'accepted', 'released', 'cancelled']);
export const untouchedTaskStatuses = new Set(['proposed', 'ready', 'cancelled']);
const terminalQueueStatuses = new Set(['integrated', 'rejected', 'failed']);
export const terminalGateStates = new Set(['succeeded', 'blocked', 'failed', 'cancelled']);
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
export const isCompletedTaskFastVerdict = ev =>
  ev?.type === 'task_fast_finished' &&
  !isAbortedTaskFast(ev) &&
  (ev?.data?.outcome === 'passed' ||
    ev?.data?.outcome === 'failed' ||
    (ev?.data?.outcome === undefined && typeof ev?.data?.passed === 'boolean'));

export const lookup = (source, id) =>
  source instanceof Map ? source.get(id) : record(source) && Object.hasOwn(source, id) ? source[id] : undefined;

export function issuedAtOf(attempt, run, events) {
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

export function integratedAtOf(run, events, queueRows) {
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

export function stoppedAtOf(attempt, run, events, queueRows) {
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

export function queueEntriesOf(attempts, eventsByRun, integrationQueue) {
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

export function agentSampleForAttempt(attempt, run, events) {
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

export function taskFastSamplesForAttempt(run, events) {
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

export function gateVerifySamples(run, events) {
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

export function gateSessionSamples(run, stage) {
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

export function quotaSamplesForRun(run, events) {
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

export function humanSamplesForRun(run, events, closedBySuccessorAt = null) {
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
