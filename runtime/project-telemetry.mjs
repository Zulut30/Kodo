/// <reference path="./project-telemetry-samples.mjs" />
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

import {
  record,
  list,
  integer,
  code,
  token,
  millis,
  iso,
  interval,
  round4,
  orderedEvents,
  percentile,
  summarizeBucket,
  integratedStatuses,
  acceptedStatuses,
  stoppedAttemptStatuses,
  closedTaskStatuses,
  untouchedTaskStatuses,
  terminalGateStates,
  isCompletedTaskFastVerdict,
  lookup,
  issuedAtOf,
  integratedAtOf,
  stoppedAtOf,
  queueEntriesOf,
  agentSampleForAttempt,
  taskFastSamplesForAttempt,
  gateVerifySamples,
  gateSessionSamples,
  quotaSamplesForRun,
  humanSamplesForRun,
} from './project-telemetry-samples.mjs';

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
