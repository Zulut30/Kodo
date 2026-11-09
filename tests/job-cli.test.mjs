import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { openJobStore } from '../runtime/job-store.mjs';
import { jobsCli } from '../runtime/job-cli.mjs';

const Q = 'project:cli';
const spec = (key, extra = {}) => ({ key, role: 'developer', writePaths: [`src/${key}.mjs`], ...extra });

function fixture(t, secrets = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'kodo-job-cli-'));
  const store = new Store(home, secrets);
  const jobs = openJobStore({ store });
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  jobs.enqueue(Q, [spec('a'), spec('b'), spec('c', { dependsOn: ['a'], payload: { taskId: 'task-c' } })]);
  const running = jobs.claim(Q, { owner: 'worker-1', limits: { workers: 1, pools: {} } });
  return { home, store, jobs, running, cli: argv => jobsCli(argv, { home, secrets }) };
}

test('jobs list reports states, reasons and the dependency graph as JSON', async t => {
  const { cli, running } = fixture(t);
  const { exitCode, report, output } = await cli(['list', '--queue', Q, '--json']);
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output), report);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.result.counts, { running: 1, queued: 2 });
  assert.deepEqual(
    report.result.jobs.map(job => [job.key, job.state, job.dependsOn, job.waitingFor]),
    [
      ['a', 'running', [], null],
      ['b', 'queued', [], null],
      ['c', 'queued', ['a'], 'dependency_pending:a'],
    ],
  );
  const [a] = report.result.jobs;
  assert.deepEqual([a.attempt, a.maxAttempts, a.leaseOwner, a.role], [1, 2, 'worker-1', 'developer']);
  assert.ok(!output.includes(running.token), 'lease tokens are never printed');
  assert.ok(!output.includes('task-c'), 'the list omits payloads');
});

test('jobs list without a queue summarizes every queue', async t => {
  const { cli, jobs } = fixture(t);
  jobs.enqueue('project:other', [spec('x')]);
  const { report } = await cli(['list', '--json']);
  assert.deepEqual(report.result.queues, [
    { queue: Q, counts: { running: 1, queued: 2 } },
    { queue: 'project:other', counts: { queued: 1 } },
  ]);
});

test('jobs status shows one job with its bounded history', async t => {
  const { cli, jobs, running } = fixture(t);
  jobs.fail(running.job.id, running.token, { reason: 'boom', retryable: false });
  const { exitCode, report } = await cli(['status', running.job.id, '--json']);
  assert.equal(exitCode, 0);
  assert.deepEqual([report.result.job.key, report.result.job.state, report.result.job.reason], ['a', 'failed', 'boom']);
  assert.deepEqual(
    report.result.events.map(event => event.type),
    ['enqueued', 'claimed', 'failed'],
  );
  const human = await cli(['status', running.job.id]);
  assert.match(human.output, /a\s+failed/);
});

test('jobs CLI is read-only', async t => {
  const { cli, jobs, store } = fixture(t);
  const before = JSON.stringify([jobs.list(Q), store.db.prepare('SELECT count(*) AS n FROM kodo_job_events').get()]);
  await cli(['list', '--queue', Q]);
  await cli(['list']);
  await cli(['status', jobs.list(Q)[1].id]);
  const after = JSON.stringify([jobs.list(Q), store.db.prepare('SELECT count(*) AS n FROM kodo_job_events').get()]);
  assert.equal(after, before, 'no sweep, claim or event is written by a report');
});

test('jobs CLI rejects unknown actions, flags and identifiers with constant diagnostics', async t => {
  const { cli } = fixture(t, { TOKEN: 'super-secret-value' });
  for (const argv of [
    [],
    ['cancel', 'x'],
    ['list', '--queue'],
    ['list', '--queue', 'bad queue'],
    ['list', '--force'],
    ['status'],
    ['status', 'not-a-uuid'],
    ['status', 'super-secret-value'],
    ['list', '--queue', Q, '--queue', Q],
  ]) {
    const { exitCode, report, output } = await cli([...argv, '--json']);
    assert.equal(exitCode, 1, argv.join(' '));
    assert.deepEqual(report.result, { status: 'invalid', code: 'jobs_arguments' });
    assert.ok(!output.includes('super-secret-value'));
  }
  const missing = await cli(['status', '00000000-0000-4000-8000-000000000000', '--json']);
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.report.result, { status: 'invalid', code: 'jobs_not_found' });
});
