import test from 'node:test';
import assert from 'node:assert/strict';

test('Project progress is bounded counts with explicit unknown, blocked and neutral evidence', async () => {
  const { buildProjectProgress } = await import('../runtime/project-progress.mjs');
  const snapshot = {
    schemaVersion: 1,
    project: {
      status: 'running',
      revision: 1,
      title: 'FAKE_SECRET',
      businessContext: 'PROMPT_DUMP',
      root: 'PRIVATE_PATH',
    },
    revision: 1,
    tasks: Array.from({ length: 1000 }, () => ({
      id: 'FAKE_SECRET',
      status: 'blocked',
      description: 'PROMPT_DUMP',
      evidence: [{ path: 'PRIVATE_PATH' }],
    })),
    milestones: [],
    epics: [],
    currentAttempts: [{ status: 'reserved', reason: 'FAKE_SECRET' }],
    riskApprovals: [],
    completeness: {},
  };
  snapshot.completeness.tasks = { total: 1001, returned: 1000, complete: false };
  const output = buildProjectProgress(snapshot);
  assert.ok(Buffer.byteLength(output, 'utf8') < 8192);
  assert.match(output, /1000/);
  assert.match(output, /1001/);
  assert.match(output, /unknown/i);
  assert.match(output, /blocked/i);
  assert.match(output, /neutral/i);
  for (const secret of ['FAKE_SECRET', 'PROMPT_DUMP', 'PRIVATE_PATH']) assert.ok(!output.includes(secret));
});

test('Progress never treats invalid counts or unrecognized status text as proof', async () => {
  const { buildProjectProgress } = await import('../runtime/project-progress.mjs');
  const output = buildProjectProgress({
    project: { status: 'SECRET_TEXT' },
    revision: NaN,
    tasks: [{ status: 'SECRET_TEXT' }],
    completeness: { tasks: { total: Infinity, returned: -1, complete: true } },
  });
  assert.doesNotMatch(output, /SECRET_TEXT|Infinity|NaN/);
  assert.match(output, /unknown/i);
  assert.match(buildProjectProgress(null), /unknown/i);
});
