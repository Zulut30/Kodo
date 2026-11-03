// Dispatch only. Persisted state, routing, worktrees and bounded retries belong
// to the caller; a fulfilled attempt need not have integrated its task yet.
export async function runReadyQueue({ tasks, limit, isIntegrated, prepare, compatible, execute, integrate, signal }) {
  const invalid = message => Object.assign(new Error(message), { code: 'invalid_plan' });
  if (!Array.isArray(tasks) || !Number.isSafeInteger(limit) || limit < 1) throw invalid('Invalid ready queue tasks or concurrency');
  const byId = new Map();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || byId.has(task.id) || !Array.isArray(task.dependsOn)) throw invalid('Ready queue requires unique task IDs and dependencies');
    byId.set(task.id, task);
  }
  const visited = new Set(), visiting = new Set();
  function visit(task) {
    if (visiting.has(task.id)) throw invalid('Cyclic ready queue dependencies');
    if (visited.has(task.id)) return;
    visiting.add(task.id);
    for (const id of task.dependsOn) {
      if (!byId.has(id)) throw invalid(`Unknown ready queue dependency: ${id}`);
      visit(byId.get(id));
    }
    visiting.delete(task.id); visited.add(task.id);
  }
  for (const task of tasks) visit(task);

  const preparing = new Set(), prepared = new Set(), busy = new Set(), completed = [], events = [];
  let integrating, pending = 0, failed = false, failure, integrationFailed = false, wake;
  const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
  const fail = error => { if (!failed) { failed = true; failure = error; } notify(); };
  const abort = () => fail(Object.assign(new Error('Запуск отменён'), { code: 'cancelled' }));
  // Every rejection is observed immediately, including synchronous callback
  // throws. Completion notifications wake one dispatcher; no polling/race loop
  // accumulates handlers on an unrelated slow execution.
  function start(kind, task, action) {
    pending++;
    Promise.resolve().then(action).then(
      () => { events.push({ kind, task, ok: true }); pending--; notify(); },
      error => {
        if (kind === 'integrate') integrationFailed = true;
        events.push({ kind, task, ok: false }); pending--; fail(error);
      }
    );
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for (;;) {
      for (const { kind, task, ok } of events.splice(0)) {
        if (kind === 'prepare') { preparing.delete(task); if (ok) prepared.add(task); }
        else if (kind === 'execute') { if (ok) completed.push(task); else busy.delete(task); }
        else { integrating = undefined; busy.delete(task); prepared.delete(task); }
      }
      try {
        // An execution/preparation failure still drains successful results.
        // A failed merge owns integration until the caller recovers it. Abort
        // leaves completed work persisted without starting a repair/session.
        if (!integrating && completed.length && !integrationFailed && !signal?.aborted) {
          integrating = completed.shift();
          const task = integrating;
          start('integrate', task, () => integrate(task));
        }
        if (!failed) {
          const ready = tasks.filter(task => !busy.has(task) && !preparing.has(task) && !isIntegrated(task) && task.dependsOn.every(id => isIntegrated(byId.get(id))));
          for (const task of ready) {
            if (busy.size + preparing.size >= limit) break;
            if (!prepared.has(task) || !compatible(task, [...busy])) continue;
            busy.add(task);
            start('execute', task, () => execute(task));
          }
          // Routing is cached while a prepared task waits for a compatible
          // slot. Preparation itself is tracked and drained like execution,
          // allowing completions to integrate while routing awaits I/O.
          for (const task of ready) {
            if (busy.size + preparing.size >= limit) break;
            if (busy.has(task) || prepared.has(task)) continue;
            preparing.add(task); start('prepare', task, () => prepare(task));
          }
          if (!pending && tasks.every(isIntegrated)) return;
          if (!pending) fail(Object.assign(new Error('Не осталось исполняемых узлов плана'), { code: 'scheduler_deadlock' }));
        }
      } catch (error) { fail(error); }
      if (failed && !pending) throw failure;
      if (!events.length) await new Promise(resolve => { wake = resolve; });
    }
  } finally { signal?.removeEventListener('abort', abort); }
}
