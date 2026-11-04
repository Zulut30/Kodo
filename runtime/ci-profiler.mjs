import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execute } from './delivery.mjs';
import { redact, stateHome, workerEnvironment } from './security.mjs';
import { inside, noLinks } from './toolchains.mjs';

const buckets = ['command', 'test', 'testFile', 'setup', 'queue', 'toolInstall', 'powershell', 'acl', 'gitWorktree', 'packageSmoke'];
const statuses = new Set(['passed', 'failed', 'cancelled', 'skipped', 'todo']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const limit = (value, fallback, maximum) => Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback;
const fields = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];

/** Normalize only documented event fields. Test names never identify files. */
export function profileEvent(event) {
  if (!event || event.type !== 'test:summary') return null;
  const data = event.data;
  if (!data || !finite(data.duration_ms) || typeof data.success !== 'boolean' || !data.counts || !fields.every(key => count(data.counts[key]))) return null;
  if (data.file !== undefined && (typeof data.file !== 'string' || !data.file || data.file.length > 4096)) return null;
  return { type: 'test:summary', data: {
    ...(data.file === undefined ? {} : { file: data.file }), duration_ms: data.duration_ms, success: data.success,
    counts: Object.fromEntries(fields.map(key => [key, data.counts[key]]))
  } };
}

function criticalPath(spans) {
  // A DAG is measured only if the producer explicitly supplies every edge list.
  if (!spans.length || spans.length > 2000 || spans.some(row => !Array.isArray(row.dependsOn))) return null;
  const nodes = new Map(spans.map(row => [row.id, row]));
  if (nodes.size !== spans.length) return null;
  const completed = new Map(), visiting = new Set();
  function visit(id) {
    if (completed.has(id)) return completed.get(id);
    const row = nodes.get(id);
    if (!row || visiting.has(id)) throw new Error('Incomplete or cyclic profile DAG');
    visiting.add(id);
    const length = row.durationMs + Math.max(0, ...row.dependsOn.map(visit));
    visiting.delete(id); completed.set(id, length); return length;
  }
  try { return Math.max(...spans.map(row => visit(row.id))); } catch { return null; }
}

/** Public, bounded, allowlisted profile. No stdout, environment, paths or args. */
export function summarizeProfile(records, options = {}) {
  if (!Array.isArray(records)) throw error('configuration', 'Profile records must be an array');
  const maxRecords = limit(options.maxRecords, 100000, 100000), maxDetails = limit(options.maxDetails, 200, 2000);
  const samples = [], spans = [], totals = []; let malformedRecords = 0, ignoredRecords = 0;
  for (const record of records.slice(0, maxRecords)) {
    if (record?.type === 'test:summary') {
      const event = profileEvent(record);
      if (!event) { malformedRecords++; continue; }
      const data = event.data;
      if (data.file === undefined) totals.push(data);
      else samples.push({ id: hash(data.file), bucket: 'testFile', durationMs: data.duration_ms, status: data.success ? 'passed' : 'failed', counts: data.counts });
    } else if (record?.kind === 'span' && buckets.includes(record.bucket) && finite(record.durationMs) && statuses.has(record.status) && typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 4096) {
      const row = { id: hash(record.id), bucket: record.bucket, durationMs: record.durationMs, status: record.status,
        ...(Number.isSafeInteger(record.attempt) && record.attempt >= 1 ? { attempt: record.attempt } : {}), flaky: record.flaky === true };
      samples.push(row);
      spans.push({ ...row, ...(finite(record.startMs) ? { startMs: record.startMs } : {}),
        ...(Array.isArray(record.dependsOn) && record.dependsOn.length <= 2000 && record.dependsOn.every(id => typeof id === 'string') ? { dependsOn: record.dependsOn.map(hash) } : {}) });
    } else if (record && typeof record.type === 'string' && record.type.startsWith('test:') && record.type !== 'test:pass' && record.type !== 'test:fail') ignoredRecords++;
    else malformedRecords++;
  }
  const distributions = Object.fromEntries(buckets.map(bucket => {
    const rows = samples.filter(row => row.bucket === bucket);
    if (!rows.length) return [bucket, null];
    const durations = rows.map(row => row.durationMs).sort((a, b) => a - b);
    const attempts = new Map();
    for (const row of rows.filter(row => row.attempt !== undefined)) {
      const group = attempts.get(row.id) ?? new Map();
      group.set(row.attempt, row.status); attempts.set(row.id, group);
    }
    const observedRetries = [...attempts.values()].reduce((total, group) => total + Math.max(0, group.size - 1), 0);
    const flakyObserved = [...attempts.values()].filter(group => {
      let failed = false;
      for (const [, status] of [...group].sort(([a], [b]) => a - b)) {
        if (status === 'passed' && failed) return true;
        if (status === 'failed') failed = true;
      }
      return false;
    }).length;
    return [bucket, { count: rows.length, failures: rows.filter(row => row.status === 'failed' || row.status === 'cancelled').length,
      cancelled: rows.filter(row => row.status === 'cancelled').length, skipped: rows.filter(row => row.status === 'skipped' || row.status === 'todo').length,
      p50Ms: durations[Math.ceil(durations.length * 0.5) - 1], p90Ms: durations[Math.ceil(durations.length * 0.9) - 1],
      minMs: durations[0], maxMs: durations.at(-1), totalMs: durations.reduce((a, b) => a + b, 0),
      retries: attempts.size ? observedRetries : null, flakyObserved: attempts.size ? flakyObserved : null,
      flakyLabelled: rows.filter(row => row.flaky).length }];
  }));
  const testCounts = totals.length ? totals.map(row => row.counts) : samples.filter(row => row.counts).map(row => row.counts);
  const tests = testCounts.length ? Object.fromEntries(fields.map(key => [key, testCounts.reduce((sum, row) => sum + row[key], 0)])) : null;
  const timed = spans.filter(row => row.startMs !== undefined);
  const wallMs = finite(options.wallMs) ? options.wallMs : totals.length === 1 ? totals[0].duration_ms : spans.length && timed.length === spans.length
    ? Math.max(...timed.map(row => row.startMs + row.durationMs)) - Math.min(...timed.map(row => row.startMs)) : null;
  return { schemaVersion: 1, wallMs, criticalPathMs: criticalPath(spans), buckets: distributions, tests,
    observedRecords: Math.min(records.length, maxRecords), malformedRecords, ignoredRecords, omittedRecords: Math.max(0, records.length - maxRecords),
    details: samples.slice(0, maxDetails).map(({ id, bucket, durationMs, status }) => ({ id, bucket, durationMs, status })),
    omittedDetails: Math.max(0, samples.length - maxDetails) };
}

async function privateDirectory(target, cwd) {
  const project = await realpath(cwd), requested = path.resolve(target); await noLinks(requested);
  let ancestor = requested; const missing = [];
  for (;;) {
    try { ancestor = path.join(await realpath(ancestor), ...missing); break; }
    catch (cause) {
      if (cause.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw cause;
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  if (inside(project, ancestor) || inside(ancestor, project) || ancestor === path.parse(ancestor).root || ancestor === await realpath(os.homedir())) throw error('unsafe_evidence', 'Profile evidence must be a dedicated directory outside the project');
  await noLinks(ancestor);
  for (let current = ancestor; ; current = path.dirname(current)) {
    try { await lstat(path.join(current, '.git')); throw error('unsafe_evidence', 'Profile evidence must remain outside Git'); }
    catch (cause) { if (!['ENOENT', 'ENOTDIR'].includes(cause.code)) throw cause; }
    if (current === path.dirname(current)) break;
  }
  await mkdir(ancestor, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(ancestor, 'profile-'));
  if (process.platform === 'win32') {
    // Fixed code, target passed via private environment. Files inherit this ACL.
    const script = "$ErrorActionPreference='Stop'; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; [IO.Directory]::SetAccessControl($env:CI_PROFILE_DIRECTORY,$acl)";
    await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...workerEnvironment(), CI_PROFILE_DIRECTORY: directory }, timeoutMs: 20000 });
  }
  return directory;
}

function eventRecords(text) {
  const records = [];
  // Non-event TAP/diagnostics stay in the raw logs; only typed JSON enters stats.
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{') || line.length > 65536) continue;
    try { const record = JSON.parse(line); if (record?.type === 'test:summary') records.push(record); }
    catch { /* truncated custom-reporter line remains in the raw log */ }
  }
  return records;
}

function cleanOutput(text, secrets) {
  // Match original byte ranges before replacement: overlapping known values
  // otherwise leave a suffix behind. Keep only one pending match per secret.
  const pending = [...new Set(Object.values(secrets))].filter(value => typeof value === 'string' && value.length > 5)
    .map(value => ({ value, index: text.indexOf(value) })).filter(match => match.index >= 0);
  const parts = []; let cursor = 0, start = -1, end = 0;
  const flush = () => { if (start >= 0) { parts.push(text.slice(cursor, start), '[REDACTED]'); cursor = end; } };
  while (pending.length) {
    let next = 0;
    for (let index = 1; index < pending.length; index++) if (pending[index].index < pending[next].index) next = index;
    const match = pending[next];
    if (start < 0 || match.index > end) { flush(); start = match.index; end = match.index + match.value.length; }
    else end = Math.max(end, match.index + match.value.length);
    match.index = text.indexOf(match.value, match.index + 1);
    if (match.index < 0) pending.splice(next, 1);
  }
  flush();
  return redact(parts.length ? parts.join('') + text.slice(cursor) : text);
}

/** Executes through Kodo's owned, shell:false port. Infrastructure errors throw
 * with profilePath/stdout/stderr attached; ordinary nonzero exits are returned. */
export async function runProfiledCommand({ command, args = [], cwd = process.cwd(), env = process.env, timeoutMs = 120000, evidenceDir = path.join(stateHome(), 'ci-profiles'), phase, tier, signal } = {}) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw error('configuration', 'Profile command, arguments and timeout are invalid');
  if (tier !== undefined && !['L0', 'L1', 'L2', 'L3'].includes(tier)) throw error('configuration', 'Unknown CI tier');
  const directory = await privateDirectory(evidenceDir, cwd), profilePath = path.join(directory, 'profile.json');
  const safeEnv = workerEnvironment(env);
  const secrets = Object.fromEntries(Object.entries(env).filter(([name]) => !(name in safeEnv)));
  const clean = value => cleanOutput(value, secrets);
  const start = performance.now(); let result, failure;
  try { result = await execute(command, args, { cwd, env, timeoutMs, signal, allowFailure: true, maxOutputBytes: 20 * 1024 * 1024, secrets }); }
  catch (cause) { failure = cause; result = cause.result ?? { code: null, stdout: cause.stdout ?? '', stderr: cause.stderr ?? '' }; }
  const durationMs = performance.now() - start;
  const stdout = clean(result.stdout ?? ''), stderr = clean(result.stderr ?? '');
  const record = { kind: 'span', id: randomUUID(), bucket: 'command', durationMs, startMs: 0, dependsOn: [], status: failure || result.code !== 0 ? 'failed' : 'passed' };
  const profile = summarizeProfile([record, ...eventRecords(stdout), ...eventRecords(stderr)], { wallMs: durationMs });
  if (tier) profile.tier = tier;
  if (['setup', 'unit', 'integration', 'security', 'package', 'release', 'quality'].includes(phase)) profile.phase = phase;
  profile.exitCode = Number.isInteger(result.code) ? result.code : null;
  profile.outputTruncated = result.outputTruncated === true;
  if (failure) profile.errorCode = ['timeout', 'cancelled', 'invalid_output', 'ENOENT', 'EACCES', 'process_teardown'].includes(failure.code) ? failure.code : 'command_error';
  await writeFile(path.join(directory, 'stdout.log'), stdout, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(directory, 'stderr.log'), stderr, { flag: 'wx', mode: 0o600 });
  if (failure) await writeFile(path.join(directory, 'error.log'), clean(failure.stack ?? failure.message), { flag: 'wx', mode: 0o600 });
  await writeFile(profilePath, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (failure) throw Object.assign(error(failure.code ?? 'command_error', 'Profiled command failed; private evidence retained'), { exitCode: profile.exitCode, durationMs, stdout, stderr, profilePath, outputTruncated: profile.outputTruncated });
  return { exitCode: profile.exitCode, durationMs, stdout, stderr, profilePath };
}
