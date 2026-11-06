#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { runProfiledCommand, summarizeProfile } from '../runtime/ci-profiler.mjs';

const fail = () => {
  throw Object.assign(
    new Error(
      'Usage: ci-profiler run [--cwd DIR] [--evidence-dir DIR] [--tier L0..L3] [--phase NAME] [--timeout-ms N] -- COMMAND [ARGS...] | summary FILE',
    ),
    { code: 'configuration' },
  );
};
try {
  const [verb, ...argv] = process.argv.slice(2);
  if (verb === 'run') {
    const options = {};
    let index = 0;
    const names = {
      '--cwd': 'cwd',
      '--evidence-dir': 'evidenceDir',
      '--tier': 'tier',
      '--phase': 'phase',
      '--timeout-ms': 'timeoutMs',
    };
    const seen = new Set();
    while (index < argv.length && argv[index] !== '--') {
      const flag = argv[index++],
        name = names[flag],
        value = argv[index++];
      if (!name || seen.has(name) || !value || value.startsWith('--')) fail();
      seen.add(name);
      options[name] = name === 'timeoutMs' && /^\d+$/.test(value) ? Number(value) : value;
    }
    if (argv[index++] !== '--' || !argv[index]) fail();
    const result = await runProfiledCommand({ ...options, command: argv[index++], args: argv.slice(index) });
    // Raw streams are in private files; public stdout is a compact JSON receipt.
    console.log(
      JSON.stringify({ exitCode: result.exitCode, durationMs: result.durationMs, profilePath: result.profilePath }),
    );
    process.exitCode = result.exitCode ?? 1;
  } else if (verb === 'summary') {
    if (argv.length !== 1) fail();
    if ((await stat(argv[0])).size > 16 * 1024 * 1024)
      throw Object.assign(new Error('Profile input exceeds 16 MiB'), { code: 'invalid_output' });
    const text = await readFile(argv[0], 'utf8');
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      input = text
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        });
    }
    if (input?.schemaVersion === 1 && input.buckets && Array.isArray(input.details)) {
      // Stored inputs may be untrusted too: allowlist nested keys, never echo them.
      const number = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
      const numeric = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
      const blank = summarizeProfile([]);
      const keys = [
        'count',
        'failures',
        'cancelled',
        'skipped',
        'p50Ms',
        'p90Ms',
        'minMs',
        'maxMs',
        'totalMs',
        'retries',
        'flakyObserved',
        'flakyLabelled',
      ];
      const safe = {
        schemaVersion: 1,
        ...numeric(input, [
          'wallMs',
          'criticalPathMs',
          'observedRecords',
          'malformedRecords',
          'ignoredRecords',
          'omittedRecords',
          'omittedDetails',
        ]),
        buckets: Object.fromEntries(
          Object.keys(blank.buckets).map(key => [key, input.buckets[key] ? numeric(input.buckets[key], keys) : null]),
        ),
        tests: input.tests ? numeric(input.tests, ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']) : null,
        details: input.details
          .slice(0, 2000)
          .filter(
            row =>
              row &&
              /^[a-f0-9]{64}$/.test(row.id) &&
              Object.hasOwn(blank.buckets, row.bucket) &&
              ['passed', 'failed', 'cancelled', 'skipped', 'todo'].includes(row.status),
          )
          .map(row => ({ id: row.id, bucket: row.bucket, status: row.status, durationMs: number(row.durationMs) })),
      };
      console.log(JSON.stringify(safe));
    } else console.log(JSON.stringify(summarizeProfile(Array.isArray(input) ? input : [input])));
  } else fail();
} catch (cause) {
  console.error(
    JSON.stringify({
      code: ['configuration', 'invalid_output', 'timeout', 'cancelled', 'ENOENT', 'EACCES'].includes(cause.code)
        ? cause.code
        : 'profiler_error',
      ...(cause.profilePath ? { profilePath: cause.profilePath } : {}),
    }),
  );
  process.exitCode = 1;
}
