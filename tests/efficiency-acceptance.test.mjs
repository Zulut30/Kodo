import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadyQueue } from '../runtime/task-scheduler.mjs';
import { compactPlanEvidence, compactReviewEvidence, measureContext } from '../runtime/context-pack.mjs';

// These scenarios depend only on the A/B public interfaces. In particular,
// passing here says nothing about later Engine prompt/evidence/RTK integration.
const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setImmediate(resolve));
const node = (id, dependsOn = [], writePaths = [`${id}.mjs`], parallel = true) => ({
  id,
  dependsOn,
  writePaths,
  parallel,
});
const observe = promise =>
  promise.then(
    () => ({ complete: true }),
    error => ({ error }),
  );
const head = 'b'.repeat(40),
  base = 'a'.repeat(40);
const paths = {
  plan: 'C:/private evidence/полный план 🦊.json',
  checks: '/private/checks.json',
  diff: '/private/full.patch',
};
const command = { command: 'node', args: ['--test', 'tests/проверка 🦊.test.mjs', '--literal=\n"quoted"'] };
const receipt = results => ({ complete: true, headSha: head, results });

function unpack(result, input, budget) {
  assert.equal(result.originalBytes, Buffer.byteLength(JSON.stringify(input), 'utf8'));
  assert.equal(result.sentBytes, Buffer.byteLength(result.text, 'utf8'));
  assert.ok(result.sentBytes <= budget, 'the advertised budget covers the entire structured document');
  const document = JSON.parse(result.text);
  assert.deepEqual(result.omitted, document.omitted);
  assert.equal(result.truncated, document.omitted.length > 0);
  function unicode(value) {
    if (typeof value === 'string')
      assert.doesNotMatch(value, /\p{Surrogate}/u, 'no isolated surrogate in retained data');
    else if (value && typeof value === 'object') for (const item of Object.values(value)) unicode(item);
  }
  unicode(document);
  return document;
}

test('Acceptance A pipelines a retried diamond before an unrelated root finishes', { timeout: 5000 }, async () => {
  const slowStarted = deferred(),
    releaseSlow = deferred();
  const integrated = new Set(['saved']),
    starts = [],
    prepares = [],
    merges = [];
  let attempts = 0;
  // Reverse dependency order also guards against a single precomputed ready list.
  const tasks = [
    node('join', ['child', 'retry']),
    node('child', ['retry', 'saved']),
    node('slow'),
    node('retry'),
    node('saved'),
  ];
  const running = observe(
    runReadyQueue({
      tasks,
      limit: 2,
      isIntegrated: task => integrated.has(task.id),
      compatible: () => true,
      prepare: async task => {
        prepares.push(task.id);
      },
      execute: async task => {
        starts.push(task.id);
        if (task.id === 'slow') {
          slowStarted.resolve();
          await releaseSlow.promise;
        }
        if (task.id === 'retry') {
          attempts++;
          await slowStarted.promise;
        }
        if (task.id === 'child') assert.ok(integrated.has('retry'), 'a successful attempt alone is not integration');
        if (task.id === 'join') assert.ok(integrated.has('child') && integrated.has('retry'));
      },
      integrate: async task => {
        merges.push(task.id);
        if (task.id !== 'retry' || attempts === 2) integrated.add(task.id);
      },
    }),
  );
  try {
    // All fixture work is promise-driven; this turn is a deterministic observation
    // point while slow is held by a handshake, not a wall-clock speed assertion.
    await turn();
    assert.ok(integrated.has('join'), 'the entire newly ready chain must progress while slow is blocked');
    assert.equal(integrated.has('slow'), false);
    assert.deepEqual(starts, ['slow', 'retry', 'retry', 'child', 'join']);
    assert.deepEqual(prepares, starts, 'one route resolution per actual attempt; no work for saved');
  } finally {
    slowStarted.resolve();
    releaseSlow.resolve();
    await running;
  }
  assert.ifError((await running).error);
  assert.deepEqual([...integrated].sort(), ['child', 'join', 'retry', 'saved', 'slow']);
  assert.equal(merges.filter(id => id === 'retry').length, 2);
});

test(
  'Acceptance A holds overlapping and nonparallel scopes until serial integration completes',
  { timeout: 5000 },
  async () => {
    const releaseMerge = deferred(),
      releaseOther = deferred();
    const integrated = new Set(),
      reserved = new Set(),
      starts = [],
      prepares = [];
    const tasks = [
      node('owner', [], ['shared.mjs']),
      node('other'),
      node('overlap', [], ['shared.mjs']),
      node('exclusive', [], ['exclusive.mjs'], false),
    ];
    const compatible = (candidate, active) =>
      !active.length ||
      (candidate.parallel &&
        active.every(other => other.parallel && !candidate.writePaths.some(path => other.writePaths.includes(path))));
    let activeMerges = 0,
      peakMerges = 0;
    const running = observe(
      runReadyQueue({
        tasks,
        limit: 3,
        isIntegrated: task => integrated.has(task.id),
        compatible,
        prepare: async task => {
          prepares.push(task.id);
        },
        execute: async task => {
          assert.ok(compatible(task, [...reserved]), 'completed but unmerged work still owns its scope');
          reserved.add(task);
          starts.push(task.id);
          assert.ok(reserved.size <= 3, 'the requested capacity includes unmerged attempts');
          if (task.id === 'other') await releaseOther.promise;
        },
        integrate: async task => {
          peakMerges = Math.max(peakMerges, ++activeMerges);
          if (task.id === 'owner') await releaseMerge.promise;
          reserved.delete(task);
          integrated.add(task.id);
          activeMerges--;
        },
      }),
    );
    try {
      await turn();
      assert.equal(activeMerges, 1, 'owner merge is held open');
      assert.deepEqual(starts, ['owner', 'other']);
      assert.deepEqual(prepares, ['owner', 'other', 'overlap', 'exclusive']);
      assert.equal(integrated.size, 0);
    } finally {
      releaseMerge.resolve();
      releaseOther.resolve();
      await running;
    }
    assert.ifError((await running).error);
    assert.deepEqual(starts, ['owner', 'other', 'overlap', 'exclusive']);
    assert.equal(new Set(prepares).size, prepares.length, 'waiting for scope must not reroute a prepared task');
    assert.equal(peakMerges, 1);
    assert.equal(reserved.size, 0);
    assert.equal(integrated.size, tasks.length);
  },
);

test(
  'Acceptance A keeps the first typed failure and drains a sibling when cancellation follows failure',
  { timeout: 5000 },
  async () => {
    class QuotaFailure extends Error {
      code = 'quota';
    }
    const original = new QuotaFailure('owned first failure');
    const siblingStarted = deferred(),
      releaseSibling = deferred(),
      controller = new AbortController();
    const prepared = [],
      completed = [],
      merges = [];
    let settled = false;
    const running = observe(
      runReadyQueue({
        tasks: [node('fails'), node('sibling'), node('never')],
        limit: 2,
        signal: controller.signal,
        isIntegrated: () => false,
        compatible: () => true,
        prepare: async task => {
          prepared.push(task.id);
        },
        execute: async task => {
          if (task.id === 'fails') {
            await siblingStarted.promise;
            throw original;
          }
          assert.equal(task.id, 'sibling');
          siblingStarted.resolve();
          await releaseSibling.promise;
          completed.push(task.id); // Models the caller's persisted result, independent of merging.
        },
        integrate: async task => {
          merges.push(task.id);
        },
      }),
    ).then(result => {
      settled = true;
      return result;
    });
    try {
      await turn();
      assert.equal(settled, false, 'failure must wait for already admitted work');
      controller.abort();
      await turn();
      assert.equal(settled, false, 'cancellation must also drain that work');
      assert.deepEqual(prepared, ['fails', 'sibling']);
    } finally {
      controller.abort();
      siblingStarted.resolve();
      releaseSibling.resolve();
      await running;
      await turn();
    }
    assert.equal((await running).error, original, 'later cancellation must not replace the original typed error');
    assert.deepEqual(completed, ['sibling']);
    assert.deepEqual(merges, [], 'abort preserves completion without starting another integration');
  },
);

test(
  'Acceptance A drains out-of-order successes without merging over a failed pending merge',
  { timeout: 5000 },
  async () => {
    const releaseMerge = deferred(),
      releaseSecond = deferred(),
      releaseThird = deferred();
    const original = Object.assign(new Error('first merge still owns recovery'), { code: 'merge_state' });
    const completed = [],
      merges = [],
      prepared = [];
    let settled = false;
    const running = observe(
      runReadyQueue({
        tasks: [node('first'), node('second'), node('third'), node('never')],
        limit: 3,
        isIntegrated: () => false,
        compatible: () => true,
        prepare: async task => {
          prepared.push(task.id);
        },
        execute: async task => {
          if (task.id === 'second') await releaseSecond.promise;
          if (task.id === 'third') await releaseThird.promise;
          completed.push(task.id);
        },
        integrate: async task => {
          merges.push(task.id);
          await releaseMerge.promise;
          throw original;
        },
      }),
    ).then(result => {
      settled = true;
      return result;
    });
    try {
      await turn();
      assert.deepEqual(merges, ['first']);
      releaseMerge.resolve();
      await turn();
      assert.equal(settled, false);
      releaseThird.resolve();
      await turn();
      assert.equal(settled, false);
      assert.deepEqual(merges, ['first']);
      assert.deepEqual(prepared, ['first', 'second', 'third']);
    } finally {
      releaseMerge.resolve();
      releaseSecond.resolve();
      releaseThird.resolve();
      await running;
    }
    assert.equal((await running).error, original);
    assert.deepEqual(completed, ['first', 'third', 'second']);
    assert.deepEqual(merges, ['first']);
  },
);

test(
  'Acceptance A cancellation drains pending routing and execution without admitting their dependents',
  { timeout: 5000 },
  async () => {
    const releaseRoute = deferred(),
      releaseExecute = deferred(),
      controller = new AbortController();
    const integrated = new Set(),
      prepared = [],
      started = [],
      completed = [],
      merges = [];
    let settled = false;
    const running = observe(
      runReadyQueue({
        tasks: [node('routing'), node('worker'), node('dependent', ['worker'])],
        limit: 2,
        signal: controller.signal,
        isIntegrated: task => integrated.has(task.id),
        compatible: () => true,
        prepare: async task => {
          prepared.push(task.id);
          if (task.id === 'routing') await releaseRoute.promise;
        },
        execute: async task => {
          started.push(task.id);
          await releaseExecute.promise;
          completed.push(task.id);
        },
        integrate: async task => {
          merges.push(task.id);
          integrated.add(task.id);
        },
      }),
    ).then(result => {
      settled = true;
      return result;
    });
    try {
      await turn();
      assert.deepEqual(started, ['worker']);
      controller.abort();
      await turn();
      assert.equal(settled, false);
      releaseExecute.resolve();
      await turn();
      assert.deepEqual(completed, ['worker']);
      assert.equal(settled, false, 'pending routing is admitted work and must also drain');
      assert.deepEqual(merges, []);
    } finally {
      controller.abort();
      releaseExecute.resolve();
      releaseRoute.resolve();
      await running;
    }
    assert.equal((await running).error?.code, 'cancelled');
    assert.deepEqual(prepared, ['routing', 'worker']);
    assert.deepEqual(started, ['worker'], 'resolved routing after cancellation must not open a worker session');
    assert.deepEqual(merges, []);
  },
);

test('Acceptance B measures Unicode bytes and bounds both compactors without corrupting input', () => {
  assert.equal(measureContext('Я🦊\n'), 7);
  const text = '🦊界е\u0301\n"'.repeat(4000);
  const inputs = [
    [
      compactPlanEvidence,
      {
        analysis: { summary: text, history: 'RAW_HISTORY', standards: 'RAW_STANDARDS' },
        research: { requests: 0, items: [], errors: [] },
        analysisPath: paths.plan,
        researchPath: '/private/research.json',
      },
    ],
    [
      compactReviewEvidence,
      {
        baseSha: base,
        headSha: head,
        checks: receipt([{ command, exitCode: 7, output: text }]),
        changedPaths: ['src/модуль 🦊.mjs'],
        diff: text,
        evidencePaths: paths,
      },
    ],
  ];
  for (const [compact, input] of inputs) {
    const before = structuredClone(input);
    for (const budget of [1200, 2048, 4097]) {
      const result = compact(input, { maxBytes: budget }),
        doc = unpack(result, input, budget);
      assert.equal(result.text, compact(input, { maxBytes: budget }).text, 'same input and budget are deterministic');
      assert.ok(result.truncated);
      assert.ok(result.omitted.every(row => row.bytes > 0 || row.items > 0));
      assert.doesNotMatch(result.text, /RAW_HISTORY|RAW_STANDARDS/);
      if (doc.kind === 'plan-evidence') {
        assert.equal(doc.evidencePaths.analysis, paths.plan);
        assert.ok(text.startsWith(doc.analysis.summary));
        assert.equal(
          doc.omitted.find(row => row.field === 'analysis.summary').bytes,
          Buffer.byteLength(text) - Buffer.byteLength(doc.analysis.summary),
        );
      } else {
        assert.deepEqual(doc.evidencePaths, paths);
        assert.equal(doc.checks.status, 'failed');
        assert.deepEqual(doc.checks.results[0].command, command);
        assert.equal(doc.checks.results[0].exitCode, 7);
      }
    }
    assert.deepEqual(input, before);
  }
  const tiny = compactPlanEvidence({});
  assert.equal(tiny.originalBytes, 2);
  assert.ok(tiny.sentBytes > tiny.originalBytes, 'metadata growth is measured rather than relabelled as savings');
});

test('Acceptance B never promotes stale partial malformed or contradictory check evidence to pass', async t => {
  const passed = { command, exitCode: 0 };
  const cases = [
    { name: 'head-bound success', checks: receipt([passed]), expected: 'passed' },
    { name: 'stale head', checks: { ...receipt([passed]), headSha: base }, expected: 'unknown' },
    { name: 'incomplete receipt', checks: { ...receipt([passed]), complete: false }, expected: 'unknown' },
    { name: 'missing receipt', checks: undefined, expected: 'unknown' },
    { name: 'missing command', checks: receipt([{ exitCode: 0 }]), expected: 'unknown' },
    { name: 'string exit code', checks: receipt([{ command, exitCode: '0' }]), expected: 'unknown' },
    {
      name: 'failed exit despite success claim',
      checks: { ...receipt([{ command, exitCode: 9 }]), passed: true },
      expected: 'failed',
    },
    {
      name: 'explicit failed result with zero exit',
      checks: receipt([{ ...passed, passed: false }]),
      expected: 'failed',
    },
    { name: 'explicit disabled gate', checks: { status: 'disabled', results: [] }, expected: 'skipped' },
    {
      name: 'mixed passing and skipped commands',
      checks: receipt([passed, { command: 'optional gate', status: 'skipped' }]),
      expected: 'unknown',
    },
  ];
  for (const row of cases)
    await t.test(row.name, () => {
      const input = {
        checks: row.checks,
        baseSha: base,
        headSha: head,
        evidencePaths: paths,
        diff: 'optional 🦊 patch\n'.repeat(2000),
      };
      const result = compactReviewEvidence(input, { maxBytes: 1500 }),
        doc = unpack(result, input, 1500);
      assert.equal(doc.checks.status, row.expected);
      assert.equal(doc.headSha, head);
      assert.equal(doc.baseSha, base);
      assert.deepEqual(doc.evidencePaths, paths);
      assert.deepEqual(
        doc.checks.results.map(result => result.exitCode),
        (row.checks?.results || []).map(result => (Number.isSafeInteger(result.exitCode) ? result.exitCode : null)),
      );
      for (let i = 0; i < (row.checks?.results || []).length; i++)
        if (row.checks.results[i].command)
          assert.deepEqual(doc.checks.results[i].command, row.checks.results[i].command);
    });
});

test('Acceptance B keeps full selected task requirements and explicitly omits whole optional task entries', () => {
  const task = {
    id: 'scoped',
    role: 'developer',
    description: 'Required behavior 🦊. '.repeat(90),
    dependsOn: ['prerequisite'],
    writePaths: ['runtime/one.mjs'],
    acceptance: ['Retain the exact error code', 'Keep the final acceptance marker: END_ACCEPTANCE'],
    constraints: ['Never call a provider', 'Never change another module'],
    interfaces: ['publicFunction({mandatory})'],
    parallel: false,
  };
  const input = {
    plan: { summary: 'Scoped contract', tasks: [task] },
    checks: receipt([{ command, exitCode: 0 }]),
    headSha: head,
    baseSha: base,
    evidencePaths: paths,
    diff: 'OPTIONAL_DIFF '.repeat(10000),
  };
  const retained = unpack(compactReviewEvidence(input, { maxBytes: 7000 }), input, 7000);
  assert.deepEqual(retained.plan.tasks, [task], 'selected requirements are never silently shortened');
  assert.ok(retained.omitted.some(row => row.field === 'diff'));
  const omitted = unpack(compactReviewEvidence(input, { maxBytes: 1300 }), input, 1300);
  assert.deepEqual(omitted.plan.tasks, []);
  assert.deepEqual(
    omitted.omitted.find(row => row.field === 'plan.tasks'),
    { field: 'plan.tasks', items: 1 },
  );
  assert.deepEqual(omitted.evidencePaths, paths, 'the complete contract remains addressable');
  // This is B's optional review projection, not proof of D's worker prompt contract.
});

test('Acceptance B rejects an impossible mandatory boundary instead of clipping commands or evidence paths', () => {
  const input = {
    checks: receipt([{ command: { command: 'node', args: ['--literal=' + '界🦊'.repeat(80)] }, exitCode: 23 }]),
    headSha: head,
    baseSha: base,
    changedPaths: [],
    evidencePaths: paths,
  };
  const full = compactReviewEvidence(input);
  const boundary = Buffer.byteLength(full.text, 'utf8');
  for (const budget of [boundary, boundary + 1]) {
    const doc = unpack(compactReviewEvidence(input, { maxBytes: budget }), input, budget);
    assert.deepEqual(doc.checks.results[0].command, input.checks.results[0].command);
    assert.equal(doc.checks.results[0].exitCode, 23);
    assert.deepEqual(doc.evidencePaths, paths);
  }
  assert.throws(() => compactReviewEvidence(input, { maxBytes: boundary - 1 }), { code: 'context_budget' });
});

test('Acceptance B accounts for every omitted manifest path while retaining mandatory failed evidence', () => {
  const input = {
    changedPaths: Array.from({ length: 300 }, (_, i) => `src/путь 🦊/${i}.mjs`),
    checks: receipt([{ command, exitCode: -1 }]),
    baseSha: base,
    headSha: head,
    evidencePaths: paths,
  };
  const doc = unpack(compactReviewEvidence(input, { maxBytes: 1500 }), input, 1500);
  assert.equal(doc.changedPaths.status, 'available');
  assert.equal(doc.changedPaths.total, 300);
  assert.ok(doc.changedPaths.omitted > 0);
  assert.equal(doc.changedPaths.paths.length + doc.changedPaths.omitted, 300);
  assert.deepEqual(doc.changedPaths.paths, input.changedPaths.slice(0, doc.changedPaths.paths.length));
  assert.deepEqual(
    doc.omitted.find(row => row.field === 'changedPaths'),
    { field: 'changedPaths', items: doc.changedPaths.omitted },
  );
  assert.equal(doc.checks.status, 'failed');
  assert.equal(doc.checks.results[0].exitCode, -1);
  assert.deepEqual(doc.evidencePaths, paths);
});

test('Acceptance B preserves discovery failure and unknown semantics after optional context is removed', async t => {
  const cases = [
    { name: 'absent research', research: undefined, expected: 'unknown' },
    { name: 'malformed request count', research: { requests: '1', items: [], errors: [] }, expected: 'unknown' },
    { name: 'explicitly skipped research', research: { status: 'skipped' }, expected: 'skipped' },
    {
      name: 'failed discovery',
      research: {
        requests: 1,
        items: [],
        errors: [{ source: 'fixture', code: 'quota', error: 'ACTIONABLE_ERROR '.repeat(1000) }],
      },
      expected: 'failed',
    },
  ];
  for (const row of cases)
    await t.test(row.name, () => {
      const input = {
        analysis: { summary: 'Optional description '.repeat(1000) },
        research: row.research,
        analysisPath: paths.plan,
        researchPath: '/private/research.json',
      };
      const doc = unpack(compactPlanEvidence(input, { maxBytes: 900 }), input, 900);
      assert.equal(doc.research.status, row.expected);
      assert.equal(doc.evidencePaths.research, '/private/research.json');
      if (row.expected === 'failed') {
        assert.equal(doc.research.errorCount, 1);
        assert.equal(doc.research.errors[0].code, 'quota');
      }
    });
});

test('Acceptance B carries only bounded verified knowledge with matching review and check heads', () => {
  const lesson = {
    runId: 'verified',
    headSha: head,
    summary: 'Preserve a checked project fact.',
    checks: receipt([{ command, exitCode: 0 }]),
    review: { passed: true, headSha: head },
    providerHistory: 'RAW_PROVIDER_HISTORY',
  };
  const input = {
    analysis: {
      summary: 'Project',
      priorLessons: [
        { ...lesson, runId: 'stale-review', review: { passed: true, headSha: base } },
        { ...lesson, runId: 'stale-check', checks: { ...lesson.checks, headSha: base } },
        { ...lesson, runId: 'failed-check', checks: receipt([{ command, exitCode: 1 }]) },
        { ...lesson, runId: 'unknown-check', checks: receipt([{ command }]) },
        lesson,
        ...[2, 3, 4].map(number => ({ ...lesson, runId: `valid-${number}`, summary: '🦊'.repeat(250) })),
      ],
      standards: 'RAW_STANDARDS',
      history: 'RAW_HISTORY',
    },
    analysisPath: paths.plan,
  };
  const doc = unpack(compactPlanEvidence(input), input, 12000);
  assert.deepEqual(
    doc.analysis.verifiedLessons.map(row => row.runId),
    ['verified', 'valid-2', 'valid-3'],
  );
  for (const row of doc.analysis.verifiedLessons) {
    assert.deepEqual(Object.keys(row).sort(), ['headSha', 'runId', 'summary']);
    assert.equal(row.headSha, head);
    assert.ok(Array.from(row.summary).length <= 200);
  }
  assert.doesNotMatch(JSON.stringify(doc), /RAW_|priorLessons|providerHistory|stale-|failed-check|unknown-check/);
  assert.equal(doc.evidencePaths.analysis, paths.plan);
});
