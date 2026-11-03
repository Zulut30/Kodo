import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../runtime/config.mjs';

test('Repair budget defaults to five preserves explicit lower limits and rejects outside one through five', async t => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'kodo-budget-'));
  t.after(async () => { assert.equal(path.dirname(project), path.resolve(os.tmpdir())); await rm(project, { recursive: true, force: true }); });
  const initial = await readConfig(project); assert.equal(initial.repairRounds, 5);
  assert.equal(initial.uiVerification.enabled, false); assert.equal(initial.security.enabled, false);
  for (const budget of [1, 2, 3, 4, 5]) {
    await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ repairRounds: budget }));
    assert.equal((await readConfig(project)).repairRounds, budget);
  }
  for (const budget of [0, 6, 1.5, '5', null]) {
    await writeFile(path.join(project, 'kodo.config.json'), JSON.stringify({ repairRounds: budget }));
    await assert.rejects(readConfig(project), /конфигурация/);
  }
});
