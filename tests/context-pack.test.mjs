import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPlanEvidence, compactReviewEvidence, measureContext } from '../runtime/context-pack.mjs';

const privatePaths = { plan: 'C:/private evidence/план-🧭.json', checks: 'C:/private evidence/checks.json', diff: 'C:/private evidence/full.diff' };
const command = { command: 'node', args: ['--test', 'tests/проверка 🧭.test.mjs'] };
const parse = result => {
  assert.equal(result.sentBytes, Buffer.byteLength(result.text, 'utf8'));
  assert.equal(measureContext(result.text), result.sentBytes);
  assert.ok(!/\p{Surrogate}/u.test(result.text), 'do not cut a Unicode surrogate pair');
  assert.deepEqual(JSON.parse(result.text).omitted, result.omitted);
  return JSON.parse(result.text);
};

test('Plan summaries exclude source bodies and inherited instructions while retaining discovery failures and full references', () => {
  const input = {
    analysis: { summary: 'CLI requirements', files: ['runtime/a.mjs'], limitations: ['No live check'], standards: 'PRIVATE_STANDARDS', priorLessons: ['PRIVATE_LESSONS'], history: 'PRIVATE_HISTORY' },
    research: { requests: 1, items: [{ url: 'https://example.test/docs', title: 'Primary docs', source: 'docs', excerpt: 'PRIVATE_BODY', body: 'PRIVATE_BODY', verification: 'discovery only' }], errors: [{ source: 'docs', code: 'quota', error: 'Quota reached' }], cache: [{ raw: 'PRIVATE_CACHE' }] },
    analysisPath: 'C:/private evidence/analysis 🧭.json', researchPath: '/private/research.json'
  };
  const result = compactPlanEvidence(input), doc = parse(result);
  assert.equal(result.originalBytes, Buffer.byteLength(JSON.stringify(input)));
  assert.equal(doc.analysis.summary, 'CLI requirements');
  assert.equal(doc.research.status, 'failed');
  assert.equal(doc.research.errors[0].code, 'quota');
  assert.equal(doc.research.sources[0].url, 'https://example.test/docs');
  assert.deepEqual(doc.evidencePaths, { analysis: input.analysisPath, research: input.researchPath });
  assert.doesNotMatch(result.text, /PRIVATE_|standards|priorLessons|history|excerpt|cache/);
});

test('Plan evidence is deterministic, UTF8 bounded and loss aware for large Unicode inputs', () => {
  const input = {
    analysis: { summary: 'Задача 🧭 é '.repeat(3000), files: Array.from({ length: 500 }, (_, i) => `src/файл-${i}.mjs`), limitations: ['Native client not checked'] },
    research: { requests: 0, items: [], errors: [] }, analysisPath: '/private/analysis.json', researchPath: '/private/research.json'
  };
  const full = compactPlanEvidence(input, { maxBytes: 200000 });
  const copy = JSON.stringify(input);
  for (const maxBytes of [1400, 4096, 12000, full.sentBytes - 1, full.sentBytes, full.sentBytes + 1]) {
    const result = compactPlanEvidence(input, { maxBytes }), doc = parse(result);
    assert.ok(result.sentBytes <= maxBytes);
    assert.equal(result.text, compactPlanEvidence(input, { maxBytes }).text);
    assert.deepEqual(doc.evidencePaths, { analysis: input.analysisPath, research: input.researchPath });
    assert.equal(result.truncated, maxBytes < full.sentBytes);
    if (result.truncated) assert.ok(result.omitted.some(row => row.bytes > 0 || row.items > 0));
  }
  assert.equal(JSON.stringify(input), copy, 'packing does not mutate saved evidence');
});

test('Plan keeps at most three head-verified lesson summaries while excluding incomplete knowledge and raw repair/provider history', () => {
  const lesson = {
    runId: 'run-verified', headSha: 'a'.repeat(40),
    summary: 'Drain already started tasks before propagating the original execution error.',
    task: 'RAW_TASK_SECRET_MARKER', standards: 'RAW_STANDARDS_SECRET_MARKER',
    review: { passed: true, headSha: 'a'.repeat(40), findings: [], provider: { raw: 'RAW_REVIEW_SECRET_MARKER' } },
    checks: [{ command: { command: 'node', args: ['--test'] }, exitCode: 0, output: 'RAW_OUTPUT_SECRET_MARKER' }],
    repaired: [{ prompt: 'RAW_REPAIR_SECRET_MARKER' }], providerHistory: [{ payload: 'RAW_PROVIDER_SECRET_MARKER' }]
  };
  const invalid = [
    { ...lesson, review: { passed: true, headSha: 'b'.repeat(40) } },
    { ...lesson, review: { passed: false, headSha: lesson.headSha } },
    { ...lesson, review: { passed: 'true', headSha: lesson.headSha } },
    { ...lesson, review: undefined },
    { ...lesson, runId: '' },
    { ...lesson, summary: '' },
    { ...lesson, checks: [{ command, exitCode: 1 }] },
    { ...lesson, checks: [{ command, exitCode: null }] },
    { ...lesson, checks: [] },
    { ...lesson, checks: undefined },
    { ...lesson, checks: { complete: false, headSha: lesson.headSha, results: [{ command, exitCode: 0 }] } },
    { ...lesson, checks: { complete: true, headSha: 'stale-check-head', results: [{ command, exitCode: 0 }] } }
  ];
  const second = { ...lesson, runId: 'run-unicode', summary: 'Урок 🧭 '.repeat(80), checks: { complete: true, headSha: lesson.headSha, results: [{ command, exitCode: 0 }] } };
  const third = { ...lesson, runId: 'run-third', summary: 'Keep the observed exit code.' };
  const input = { analysis: { summary: 'Improve task scheduling', priorLessons: [...invalid, lesson, second, third, { ...lesson, runId: 'run-fourth' }] }, analysisPath: '/private/head/analysis.json' };
  const snapshot = JSON.stringify(input);
  const result = compactPlanEvidence(input), doc = parse(result);
  assert.deepEqual(doc.analysis.verifiedLessons.map(row => row.runId), ['run-verified', 'run-unicode', 'run-third']);
  assert.deepEqual(doc.analysis.verifiedLessons[0], { runId: lesson.runId, headSha: lesson.headSha, summary: lesson.summary });
  assert.equal(Array.from(doc.analysis.verifiedLessons[1].summary).length, 200);
  assert.ok(doc.analysis.verifiedLessons[1].summary.endsWith('…'));
  assert.ok(doc.analysis.verifiedLessons.every(row => Object.keys(row).sort().join(',') === 'headSha,runId,summary'));
  assert.doesNotMatch(result.text, /RAW_|SECRET_MARKER|priorLessons|repaired|providerHistory|standards/);
  assert.equal(doc.evidencePaths.analysis, input.analysisPath);
  assert.equal(JSON.stringify(input), snapshot, 'selecting memory never edits stored lessons');
  const bounded = compactPlanEvidence(input, { maxBytes: 1100 });
  assert.ok(bounded.sentBytes <= 1100);
  assert.ok(bounded.omitted.some(row => row.field === 'analysis.verifiedLessons' && row.items > 0));
});

test('Review retains exact command exits and failed skipped unknown semantics rather than promoting malformed evidence to pass', () => {
  const rows = [
    { command, exitCode: 1, output: 'START\n' + 'noise 🧭'.repeat(10000) + '\nFAILURE_SENTINEL' },
    { command: 'npm run lint', status: 'skipped' },
    { command: 'npm run build', exitCode: '0' },
    { command: 'npm test', exitCode: 0 },
    { exitCode: 0 },
    null
  ];
  const input = { plan: { summary: 'Fix command', tasks: [] }, checks: { headSha: 'head', complete: true, results: rows }, baseSha: 'base', headSha: 'head', diffStat: '2 files', changedPaths: ['a.mjs', 'b.mjs'], diff: 'diff 🧭'.repeat(50000), evidencePaths: privatePaths };
  const result = compactReviewEvidence(input), doc = parse(result);
  assert.ok(result.sentBytes <= 16000);
  assert.equal(doc.baseSha, 'base'); assert.equal(doc.headSha, 'head');
  assert.equal(doc.checks.status, 'failed');
  assert.deepEqual(doc.checks.results.map(row => row.status), ['failed', 'skipped', 'unknown', 'passed', 'unknown', 'unknown']);
  assert.deepEqual(doc.checks.results[0].command, command);
  assert.deepEqual(doc.checks.results.map(row => row.exitCode), [1, null, null, 0, 0, null]);
  assert.match(doc.checks.results[0].output, /FAILURE_SENTINEL/);
  assert.deepEqual(doc.evidencePaths, privatePaths);
  assert.equal(doc.changedPaths.omitted, 0);
  assert.deepEqual(doc.changedPaths.paths, input.changedPaths);
});

test('Missing malformed partial stale and contradictory receipts never appear passed', () => {
  for (const checks of [undefined, null, 'passed', [], {}, { complete: true, results: [] }, { complete: false, results: [{ command, exitCode: 0 }] }, { complete: true, results: [{ command, exitCode: '0' }] }, { complete: true, headSha: 'old', results: [{ command, exitCode: 0 }] }, { complete: true, status: 'unknown', results: [{ command, exitCode: 0 }] }, { complete: true, results: [{ command, exitCode: 0 }] }, { complete: true, headSha: 123, results: [{ command, exitCode: 0 }] }, [{ command, exitCode: 0 }]]) {
    const doc = parse(compactReviewEvidence({ checks, headSha: 'current' }));
    assert.equal(doc.checks.status, 'unknown', JSON.stringify(checks));
  }
  const passed = parse(compactReviewEvidence({ checks: { complete: true, headSha: 'current', results: [{ command, exitCode: 0 }] }, headSha: 'current' }));
  assert.equal(passed.checks.status, 'passed');
  for (const status of ['skipped', 'disabled']) {
    const skipped = parse(compactReviewEvidence({ checks: { status, results: [] } }));
    assert.equal(skipped.checks.status, 'skipped');
  }
  const failed = parse(compactReviewEvidence({ checks: { status: 'passed', complete: true, results: [{ command, exitCode: 5 }] } }));
  assert.equal(failed.checks.status, 'failed');
});

test('A bounded changed-path manifest reports its exact omitted count and never shortens artifact references', () => {
  const changedPaths = Array.from({ length: 500 }, (_, i) => `src/путь 🧭-${i}.mjs`);
  const input = { changedPaths, baseSha: 'base', headSha: 'head', evidencePaths: privatePaths, checks: { complete: true, results: [{ command, exitCode: 0 }] } };
  const doc = parse(compactReviewEvidence(input, { maxBytes: 1600 }));
  assert.equal(doc.changedPaths.total, changedPaths.length);
  assert.ok(doc.changedPaths.omitted > 0);
  assert.equal(doc.changedPaths.paths.length + doc.changedPaths.omitted, changedPaths.length);
  assert.deepEqual(doc.changedPaths.paths, changedPaths.slice(0, doc.changedPaths.paths.length));
  assert.deepEqual(doc.evidencePaths, privatePaths);
  assert.deepEqual(doc.checks.results[0].command, command);
});

test('Compact review task summaries exclude nested inherited instructions and keep complete selected task contracts', () => {
  const task = { id: 'a', role: 'developer', description: 'Implement exactly', writePaths: ['runtime/a.mjs'], acceptance: ['Check the exit code'], constraints: ['No native calls'], interfaces: ['f()'], dependsOn: [], parallel: true, standards: 'PRIVATE_STANDARDS', history: ['PRIVATE_HISTORY'] };
  const result = compactReviewEvidence({ plan: { summary: 'One task', tasks: [task], priorLessons: 'PRIVATE_LESSONS' } });
  const doc = parse(result), { standards, history, ...expected } = task;
  assert.deepEqual(doc.plan.tasks, [expected]);
  assert.doesNotMatch(result.text, /PRIVATE_|standards|priorLessons|history/);
});

test('Unknown discovery evidence stays unknown, explicit skipped stays skipped and tiny payload growth is measured honestly', () => {
  for (const research of [undefined, {}, { items: [], errors: [] }, { requests: '0', items: [], errors: [] }, { status: 'unknown', requests: 1, items: [], errors: [] }, { requests: 1, items: [null], errors: [] }]) {
    assert.equal(parse(compactPlanEvidence({ research })).research.status, 'unknown');
  }
  assert.equal(parse(compactPlanEvidence({ research: { status: 'skipped' } })).research.status, 'skipped');
  assert.equal(parse(compactPlanEvidence({ research: { requests: 0, items: [], errors: [] } })).research.status, 'skipped');
  const tiny = compactPlanEvidence({});
  assert.equal(tiny.originalBytes, 2);
  assert.ok(tiny.sentBytes - tiny.originalBytes > 0, 'signed growth is not clamped to savings');
  assert.equal(tiny.truncated, false);
});

test('Malformed manifests expose invalid entries and evidence path ordering does not affect deterministic rendering', () => {
  const first = compactReviewEvidence({ changedPaths: ['src/a.mjs', null, 42], evidencePaths: { checks: '/private/checks.json', diff: '/private/diff.patch' } });
  const second = compactReviewEvidence({ evidencePaths: { diff: '/private/diff.patch', checks: '/private/checks.json' }, changedPaths: ['src/a.mjs', null, 42] });
  const doc = parse(first);
  assert.equal(doc.changedPaths.status, 'unknown');
  assert.equal(doc.changedPaths.total, 3);
  assert.equal(doc.changedPaths.invalid, 2);
  assert.deepEqual(doc.changedPaths.paths, ['src/a.mjs']);
  assert.equal(first.text, second.text);
});

test('Impossible or invalid byte budgets fail explicitly without truncating required command or path data', () => {
  const input = { checks: { complete: true, results: [{ command: 'x'.repeat(3000), exitCode: 1 }] }, evidencePaths: privatePaths };
  assert.throws(() => compactReviewEvidence(input, { maxBytes: 1500 }), error => error.code === 'context_budget' && /mandatory|budget/i.test(error.message));
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, '16000']) {
    assert.throws(() => compactPlanEvidence({}, { maxBytes }), /budget/i);
  }
  assert.throws(() => measureContext({}), /string/i);
});
