/** Actual UTF-8 text bytes. These are neither billed tokens nor quota usage. */
export function measureContext(text) {
  if (typeof text !== 'string') throw new TypeError('Context measurement requires a string');
  return Buffer.byteLength(text, 'utf8');
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const bytes = value => measureContext(JSON.stringify(value));

function evidencePaths(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return strings(value);
  if (!record(value)) return null;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, string(value[key])]));
}

// Callers persist/redact full evidence before packing. This module does no I/O,
// never resolves paths against cwd and never shortens a supplied artifact path.
// originalBytes measures the complete supplied input JSON, including references;
// sentBytes measures the final metadata JSON. omitted/truncated describe budget
// losses within the allowlist, not fields deliberately excluded by that schema.
function pack(original, document, fields, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Object.assign(new RangeError('Context byte budget must be a positive safe integer'), { code: 'context_budget' });
  const originalBytes = bytes(original);
  document.omitted = [];
  const candidates = fields.map(([owner, key, field, tail = false, onChange]) => {
    const full = owner[key], array = Array.isArray(full), units = array ? full : Array.from(full);
    return { owner, key, field, tail, onChange, full, array, units, kept: units.length, size: bytes(full) };
  });
  function set(candidate, kept) {
    const { owner, key, units, full, array, tail, onChange } = candidate;
    candidate.kept = kept;
    if (kept === units.length) owner[key] = full;
    else if (array) owner[key] = units.slice(0, kept);
    else if (!kept) owner[key] = '';
    else if (tail) owner[key] = units.slice(0, Math.ceil(kept / 2)).join('') + '\n…\n' + units.slice(units.length - Math.floor(kept / 2)).join('');
    else owner[key] = units.slice(0, kept).join('');
    onChange?.(units.length - kept);
    document.omitted = candidates.filter(row => row.kept < row.units.length).map(row => {
      if (row.array) return { field: row.field, items: row.units.length - row.kept };
      const keptText = row.tail && row.kept ? row.units.slice(0, Math.ceil(row.kept / 2)).join('') + row.units.slice(row.units.length - Math.floor(row.kept / 2)).join('') : row.units.slice(0, row.kept).join('');
      return { field: row.field, bytes: measureContext(row.full) - measureContext(keptText) };
    });
  }
  // Preserve small details first; discard the largest optional body only as
  // necessary. Arrays lose whole items, strings lose complete Unicode points.
  for (const candidate of [...candidates].sort((a, b) => b.size - a.size)) {
    if (bytes(document) <= maxBytes) break;
    const before = bytes(document);
    set(candidate, 0);
    if (bytes(document) >= before) { set(candidate, candidate.units.length); continue; }
    if (bytes(document) > maxBytes) continue;
    let low = 0, high = candidate.units.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      set(candidate, middle);
      if (bytes(document) <= maxBytes) low = middle; else high = middle - 1;
    }
    set(candidate, low);
  }
  const text = JSON.stringify(document), sentBytes = measureContext(text);
  if (sentBytes > maxBytes) throw Object.assign(new RangeError(`Context byte budget ${maxBytes} cannot retain mandatory evidence (${sentBytes} bytes); split the input or increase the budget`), { code: 'context_budget' });
  return { text, originalBytes, sentBytes, truncated: document.omitted.length > 0, omitted: document.omitted };
}

function addText(fields, owner, key, value, field, tail = false) {
  owner[key] = string(value);
  if (owner[key] !== null) fields.push([owner, key, field, tail]);
}

function addStrings(fields, owner, key, value, field) {
  owner[key] = strings(value);
  fields.push([owner, key, field]);
}

// The caller supplies relevant project-scoped lessons in priority order. This
// projects existing recorded evidence; it performs no new review or storage.
function verifiedLessonSummaries(lessons) {
  const selected = [];
  if (!Array.isArray(lessons)) return selected;
  for (const lesson of lessons) {
    if (!record(lesson) || typeof lesson.runId !== 'string' || !lesson.runId.trim() || typeof lesson.headSha !== 'string' || !lesson.headSha.trim() || typeof lesson.summary !== 'string' || !lesson.summary.trim() || lesson.review?.passed !== true || lesson.review.headSha !== lesson.headSha) continue;
    const results = Array.isArray(lesson.checks) ? lesson.checks : lesson.checks?.results;
    if (!Array.isArray(results) || !results.length || !Array.from(results).every(record)) continue;
    // Stored knowledge uses command/exit arrays. Also accept complete receipts
    // only when their own head matches; unknown, skipped or failed checks do
    // not establish verified knowledge, even alongside a passing review.
    const checks = Array.isArray(lesson.checks) ? { complete: true, headSha: lesson.headSha, results } : lesson.checks;
    if (checkEvidence(checks, lesson.headSha, []).status !== 'passed') continue;
    const summary = Array.from(lesson.summary.trim());
    selected.push({ runId: lesson.runId, headSha: lesson.headSha, summary: summary.length <= 200 ? summary.join('') : summary.slice(0, 199).join('') + '…' });
    if (selected.length === 3) break;
  }
  return selected;
}

/** Bounded allowlisted analysis/discovery metadata; source bodies, cache,
 * standards, raw lessons and histories are excluded. analysis.verifiedLessons
 * contains at most 3 {runId, headSha, summary} projections from priorLessons:
 * exact passing review/head binding, nonempty successful checks, <=200 Unicode
 * points per summary. Full lesson content remains at analysisPath. The byte
 * budget may omit whole projected lessons with an explicit omitted item count. */
export function compactPlanEvidence({ analysis, research, analysisPath, researchPath } = {}, { maxBytes = 12000 } = {}) {
  const fields = [];
  const a = { status: record(analysis) && typeof analysis.summary === 'string' && analysis.summary.trim() ? 'available' : 'unknown' };
  for (const key of ['summary', 'kind', 'model']) addText(fields, a, key, analysis?.[key], `analysis.${key}`);
  for (const key of ['files', 'limitations', 'risks']) addStrings(fields, a, key, analysis?.[key], `analysis.${key}`);
  a.verifiedLessons = verifiedLessonSummaries(analysis?.priorLessons);
  fields.push([a, 'verifiedLessons', 'analysis.verifiedLessons']);
  const valid = record(research) && Array.isArray(research.items) && research.items.every(item => record(item) && typeof item.url === 'string' && item.url.trim()) && Array.isArray(research.errors) && count(research.requests) !== null;
  const errors = Array.isArray(research?.errors) ? research.errors : [];
  const items = Array.isArray(research?.items) ? research.items : [];
  const r = { status: errors.length || ['failed', 'blocked', 'error'].includes(research?.status) ? 'failed' : ['skipped', 'disabled'].includes(research?.status) ? 'skipped' : !valid || research?.status === 'unknown' ? 'unknown' : research.requests === 0 && !items.length ? 'skipped' : 'available', requests: count(research?.requests), sourceCount: Array.isArray(research?.items) ? items.length : null, errorCount: Array.isArray(research?.errors) ? errors.length : null };
  r.errors = errors.map((error, index) => {
    const row = { source: string(error?.source), code: string(error?.code) };
    addText(fields, row, 'error', error?.error, `research.errors[${index}].error`, true);
    return row;
  });
  r.sources = items.map(item => Object.fromEntries(['url', 'title', 'source', 'compatibility', 'verification'].map(key => [key, string(item?.[key])])));
  fields.push([r, 'sources', 'research.sources']);
  return pack({ analysis, research, analysisPath, researchPath }, { schemaVersion: 1, kind: 'plan-evidence', evidencePaths: { analysis: string(analysisPath), research: string(researchPath) }, analysis: a, research: r }, fields, maxBytes);
}

const failedStatuses = new Set(['failed', 'blocked', 'error', 'cancelled']);
const skippedStatuses = new Set(['skipped', 'disabled']);
function checkCommand(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (record(value) && typeof value.command === 'string' && value.command.trim() && Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string')) return { command: value.command, args: [...value.args] };
  return null;
}

function checkEvidence(checks, headSha, fields) {
  const input = Array.isArray(checks) ? checks : Array.isArray(checks?.results) ? checks.results : [];
  const results = input.map((row, index) => {
    const command = checkCommand(row?.command), exitCode = Number.isSafeInteger(row?.exitCode) ? row.exitCode : null;
    const status = (exitCode !== null && exitCode !== 0) || row?.passed === false || failedStatuses.has(row?.status) ? 'failed'
      : skippedStatuses.has(row?.status) && exitCode === null ? 'skipped'
        : command && exitCode === 0 && (row?.status === undefined || row.status === 'passed') ? 'passed' : 'unknown';
    const result = { kind: string(row?.kind), command, exitCode, status };
    addText(fields, result, 'output', row?.output, `checks.results[${index}].output`, true);
    return result;
  });
  const counts = { passed: 0, failed: 0, skipped: 0, unknown: 0 };
  for (const row of results) counts[row.status]++;
  const unbound = typeof headSha !== 'string' || !headSha.trim() || typeof checks?.headSha !== 'string' || checks.headSha !== headSha;
  const complete = typeof checks?.complete === 'boolean' ? checks.complete : null;
  const status = counts.failed || checks?.passed === false || failedStatuses.has(checks?.status) ? 'failed'
    : skippedStatuses.has(checks?.status) && !results.length ? 'skipped'
      : !results.length || counts.unknown || unbound || complete !== true || (checks?.status !== undefined && checks.status !== 'passed') ? 'unknown'
        : counts.skipped === results.length ? 'skipped' : counts.skipped ? 'unknown' : 'passed';
  return { status, complete, headSha: string(checks?.headSha), counts, results };
}

function planTask(task) {
  if (!record(task)) return { status: 'unknown' };
  const result = { id: string(task.id), role: string(task.role), description: string(task.description) };
  for (const key of ['dependsOn', 'writePaths', 'acceptance']) result[key] = strings(task[key]);
  for (const key of ['interfaces', 'constraints']) if (task[key] !== undefined) result[key] = typeof task[key] === 'string' ? task[key] : strings(task[key]);
  if (typeof task.parallel === 'boolean') result.parallel = task.parallel;
  return result;
}

/** Checks/commands/exits, head/base and references are never shortened. A
 * manifest or task summary may lose whole entries with an explicit count.
 * Impossible budgets throw context_budget rather than return invalid JSON or
 * disguise missing evidence as a successful receipt. */
export function compactReviewEvidence({ plan, checks, baseSha, headSha, diffStat, changedPaths, diff, evidencePaths: paths } = {}, { maxBytes = 16000 } = {}) {
  const fields = [], p = { status: record(plan) && Array.isArray(plan.tasks) ? 'available' : 'unknown' };
  addText(fields, p, 'summary', plan?.summary, 'plan.summary');
  p.tasks = Array.isArray(plan?.tasks) ? plan.tasks.map(planTask) : [];
  fields.push([p, 'tasks', 'plan.tasks']);
  const manifest = { status: Array.isArray(changedPaths) && changedPaths.every(item => typeof item === 'string') ? 'available' : 'unknown', total: Array.isArray(changedPaths) ? changedPaths.length : null, paths: strings(changedPaths), omitted: 0, invalid: Array.isArray(changedPaths) ? changedPaths.length - strings(changedPaths).length : null };
  fields.push([manifest, 'paths', 'changedPaths', false, omitted => { manifest.omitted = omitted; }]);
  const document = { schemaVersion: 1, kind: 'review-evidence', evidencePaths: evidencePaths(paths), baseSha: string(baseSha), headSha: string(headSha), plan: p, checks: checkEvidence(checks, headSha, fields), changedPaths: manifest };
  addText(fields, document, 'diffStat', diffStat, 'diffStat');
  addText(fields, document, 'diff', diff, 'diff', true);
  return pack({ plan, checks, baseSha, headSha, diffStat, changedPaths, diff, evidencePaths: paths }, document, fields, maxBytes);
}
