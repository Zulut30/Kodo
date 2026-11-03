import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskContext } from '../runtime/task-context.mjs';

test('Task context preserves scope acceptance interfaces and direct dependencies without nested history', () => {
  const task = { id: 'worker', role: 'developer', description: 'Implement src/value.mjs', writePaths: ['src/value.mjs'], acceptance: ['Value equals two'], interfaces: ['value() returns number'], constraints: ['Subscription only'], dependsOn: ['base'] };
  const run = { task: 'Build a feature', plan: { tasks: [task, { id: 'base', description: 'Base interface' }, { id: 'other', description: 'UNRELATED_TASK' }] }, nodes: { base: { status: 'integrated', headSha: 'abc', result: { summary: 'Interface ready', prompt: 'NESTED_PROMPT' } }, other: { result: { summary: 'UNRELATED_RESULT' } } }, analysis: { summary: 'A small value module', standards: 'PINNED_HISTORY'.repeat(5000), history: 'RAW_HISTORY' }, research: { items: [{ url: 'https://example.test/value', title: 'src/value.mjs contract', excerpt: 'RAW_RESEARCH' }] } };
  const context = buildTaskContext(run, task);
  for (const text of ['src/value.mjs', 'Value equals two', 'value() returns number', 'Subscription only', 'Interface ready', 'https://example.test/value']) assert.ok(context.includes(text), text);
  for (const text of ['PINNED_HISTORY', 'RAW_HISTORY', 'RAW_RESEARCH', 'NESTED_PROMPT', 'UNRELATED_RESULT', 'UNRELATED_TASK']) assert.ok(!context.includes(text), text);
  assert.ok(context.length <= 16000);
});

test('Task context bounds oversized optional data and redacts credential URLs', () => {
  const task = { id: 'one', description: 'Fix src/one', writePaths: ['src/one'], acceptance: ['Preserve required boundary'], dependsOn: [] };
  const context = buildTaskContext({ task: 'x'.repeat(100000), analysis: { summary: 'y'.repeat(100000) }, research: { items: [{ url: 'https://example.test/src/one?token=secret-value', title: 'src/one', body: 'z'.repeat(100000) }] } }, task);
  assert.ok(context.length <= 16000);
  assert.match(context, /Preserve required boundary/);
  assert.ok(!context.includes('secret-value'));
});
